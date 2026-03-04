import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolve_auth_token } from "./config";
import { daemon_ingress_server, type daemon_health_snapshot } from "./daemon_ingress_server";
import { mcp_stdio_server } from "./mcp_stdio_server";
import { local_mcp_runtime, type runtime_options } from "./runtime";
import { stdio_proxy_server } from "./stdio_proxy_server";

interface daemon_auth_resolution {
  auth_token?: string;
  generated_automatically: boolean;
  auto_requested: boolean;
}

interface daemon_state_record {
  service: "local-mcp-daemon";
  pid: number;
  started_at: string;
  updated_at: string;
  daemon_host: string;
  daemon_port: number;
  bridge_host: string;
  bridge_port: number;
  auth_enabled: boolean;
  auth_auto: boolean;
  auth_token?: string;
  auth_token_hint?: string;
}

export interface daemon_run_options {
  daemon_mode: "auto" | "proxy" | "daemon" | "direct";
  daemon_host: string;
  daemon_port: number;
  daemon_idle_timeout_ms: number;
  daemon_connect_timeout_ms: number;
  daemon_state_path: string;
  runtime_options: runtime_options;
  env: Record<string, string | undefined>;
}

const daemon_health_poll_interval_ms = 200;
const daemon_health_request_timeout_ms = 750;

function get_non_empty_string(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

function resolve_default_state_path(daemon_port: number): string {
  return join(tmpdir(), `local-mcp-bun-daemon-${daemon_port}.json`);
}

export function resolve_daemon_state_path(
  env: Record<string, string | undefined>,
  daemon_port: number,
  cwd = process.cwd(),
): string {
  const configured = get_non_empty_string(env.MCP_DAEMON_STATE_PATH);
  if (!configured) {
    return resolve_default_state_path(daemon_port);
  }

  if (configured.startsWith("/")) {
    return configured;
  }

  return resolve(cwd, configured);
}

function read_daemon_state(path: string): daemon_state_record | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<daemon_state_record>;
    if (parsed.service !== "local-mcp-daemon") {
      return undefined;
    }

    if (typeof parsed.daemon_port !== "number" || typeof parsed.bridge_port !== "number") {
      return undefined;
    }

    return parsed as daemon_state_record;
  } catch {
    return undefined;
  }
}

function write_daemon_state(path: string, state: daemon_state_record): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function build_token_hint(token: string): string {
  if (token.length <= 12) {
    return `${token.slice(0, 2)}***`;
  }

  return `${token.slice(0, 8)}***`;
}

function resolve_daemon_auth(
  env: Record<string, string | undefined>,
  daemon_state: daemon_state_record | undefined,
): daemon_auth_resolution {
  const configured = get_non_empty_string(env.MCP_AUTH_TOKEN);
  if (configured && configured !== "auto") {
    return {
      auth_token: configured,
      generated_automatically: false,
      auto_requested: false,
    };
  }

  const auto_requested = configured === "auto" || get_non_empty_string(env.MCP_AUTH_AUTO) === "1";
  if (!auto_requested) {
    return {
      auth_token: undefined,
      generated_automatically: false,
      auto_requested: false,
    };
  }

  const reused = get_non_empty_string(daemon_state?.auth_token);
  if (reused) {
    return {
      auth_token: reused,
      generated_automatically: false,
      auto_requested: true,
    };
  }

  return {
    auth_token: `auto-${crypto.randomUUID()}`,
    generated_automatically: true,
    auto_requested: true,
  };
}

async function fetch_daemon_health(
  daemon_host: string,
  daemon_port: number,
  timeout_ms: number,
): Promise<daemon_health_snapshot | undefined> {
  const controller = new AbortController();
  const timeout_id = setTimeout(() => controller.abort(), timeout_ms);
  const url = `http://${daemon_host}:${daemon_port}/health`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      method: "GET",
    });
    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as Partial<daemon_health_snapshot>;
    if (payload.service !== "local-mcp-daemon") {
      return undefined;
    }

    if (typeof payload.pid !== "number" || typeof payload.daemon_port !== "number") {
      return undefined;
    }

    return payload as daemon_health_snapshot;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout_id);
  }
}

async function wait_for_daemon_health(
  daemon_host: string,
  daemon_port: number,
  timeout_ms: number,
): Promise<daemon_health_snapshot | undefined> {
  const started_at = Date.now();

  while (Date.now() - started_at < timeout_ms) {
    const health = await fetch_daemon_health(daemon_host, daemon_port, daemon_health_request_timeout_ms);
    if (health) {
      return health;
    }

    await new Promise((resolve_promise) => {
      setTimeout(resolve_promise, daemon_health_poll_interval_ms);
    });
  }

  return undefined;
}

function spawn_detached_daemon_process(
  daemon_mode: daemon_run_options["daemon_mode"],
  env: Record<string, string | undefined>,
): void {
  if (daemon_mode !== "auto") {
    return;
  }

  const command = process.argv[0];
  const args = process.argv.slice(1);
  const detached_process = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...env,
      MCP_DAEMON_MODE: "daemon",
    },
  });
  detached_process.unref();
}

function register_runtime_signal_handlers(runtime: local_mcp_runtime): void {
  process.on("SIGINT", () => {
    runtime.stop().finally(() => {
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    runtime.stop().finally(() => {
      process.exit(0);
    });
  });
}

function register_daemon_signal_handlers(
  runtime: local_mcp_runtime,
  ingress: daemon_ingress_server,
  daemon_state: daemon_state_record,
  daemon_state_path: string,
): void {
  const shutdown = () => {
    daemon_state.updated_at = new Date().toISOString();
    write_daemon_state(daemon_state_path, daemon_state);
    ingress
      .stop()
      .catch(() => {
        // ignore ingress cleanup errors
      })
      .finally(() => {
        runtime
          .stop()
          .catch(() => {
            // ignore runtime cleanup errors
          })
          .finally(() => {
            process.exit(0);
          });
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function start_direct_runtime(options: daemon_run_options): Promise<void> {
  const auth = resolve_auth_token(options.env);

  const runtime = new local_mcp_runtime({
    ...options.runtime_options,
    auth_token: auth.auth_token,
  });

  if (auth.generated_automatically) {
    console.error(`[auth] generated one-time MCP token for this server run: ${auth.auth_token}`);
  }

  const stdio_server = new mcp_stdio_server(runtime);
  stdio_server.start();
  register_runtime_signal_handlers(runtime);
}

async function start_daemon_runtime(options: daemon_run_options): Promise<void> {
  const daemon_state = read_daemon_state(options.daemon_state_path);
  const auth = resolve_daemon_auth(options.env, daemon_state);
  const auth_token_hint = auth.auth_token ? build_token_hint(auth.auth_token) : undefined;
  const runtime = new local_mcp_runtime({
    ...options.runtime_options,
    auth_token: auth.auth_token,
  });

  const state: daemon_state_record = {
    service: "local-mcp-daemon",
    pid: process.pid,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    daemon_host: options.daemon_host,
    daemon_port: options.daemon_port,
    bridge_host: options.runtime_options.bridge_host,
    bridge_port: options.runtime_options.bridge_port,
    auth_enabled: typeof auth.auth_token === "string" && auth.auth_token.length > 0,
    auth_auto: auth.auto_requested,
    auth_token: auth.auto_requested ? auth.auth_token : undefined,
    auth_token_hint,
  };
  write_daemon_state(options.daemon_state_path, state);

  const ingress = new daemon_ingress_server({
    runtime,
    daemon_host: options.daemon_host,
    daemon_port: options.daemon_port,
    bridge_host: options.runtime_options.bridge_host,
    bridge_port: options.runtime_options.bridge_port,
    daemon_state_path: options.daemon_state_path,
    idle_timeout_ms: options.daemon_idle_timeout_ms,
    auth_enabled: state.auth_enabled,
    auth_token_hint: state.auth_token_hint,
    on_idle_timeout: async () => {
      state.updated_at = new Date().toISOString();
      write_daemon_state(options.daemon_state_path, state);
      await ingress.stop();
      await runtime.stop();
      process.exit(0);
    },
  });

  register_daemon_signal_handlers(runtime, ingress, state, options.daemon_state_path);

  if (auth.auto_requested && auth.auth_token) {
    console.error(`[auth] daemon token for initialize.params.token: ${auth.auth_token}`);
  }

  if (state.auth_enabled) {
    console.error(
      `[daemon] auth token enabled (hint=${state.auth_token_hint ?? "redacted"}); clients must pass token in initialize.params.token`,
    );
  }
}

async function start_proxy_runtime(
  options: daemon_run_options,
  daemon_health: daemon_health_snapshot,
): Promise<void> {
  const auto_requested =
    get_non_empty_string(options.env.MCP_AUTH_TOKEN) === "auto" || get_non_empty_string(options.env.MCP_AUTH_AUTO) === "1";

  if (auto_requested) {
    const daemon_state = read_daemon_state(options.daemon_state_path);
    if (daemon_state?.auth_token) {
      console.error(`[auth] daemon token for initialize.params.token: ${daemon_state.auth_token}`);
    }
  }

  if (daemon_health.auth_enabled) {
    console.error(`[daemon] connected shared runtime auth hint: ${daemon_health.auth_token_hint ?? "redacted"}`);
  }

  const proxy_server = new stdio_proxy_server({
    daemon_url: `ws://${options.daemon_host}:${options.daemon_port}/mcp`,
    connect_timeout_ms: options.daemon_connect_timeout_ms,
  });
  await proxy_server.start();
}

export async function run_daemon_mode(options: daemon_run_options): Promise<void> {
  if (options.daemon_mode === "direct") {
    await start_direct_runtime(options);
    return;
  }

  if (options.daemon_mode === "daemon") {
    await start_daemon_runtime(options);
    return;
  }

  let health = await fetch_daemon_health(
    options.daemon_host,
    options.daemon_port,
    Math.min(daemon_health_request_timeout_ms, options.daemon_connect_timeout_ms),
  );

  if (!health && options.daemon_mode === "auto") {
    spawn_detached_daemon_process(options.daemon_mode, {
      BRIDGE_MODE: options.runtime_options.bridge_mode,
      BRIDGE_HOST: options.runtime_options.bridge_host,
      BRIDGE_PORT: String(options.runtime_options.bridge_port),
      MCP_DAEMON_PORT: String(options.daemon_port),
      MCP_DAEMON_IDLE_TIMEOUT_MS: String(options.daemon_idle_timeout_ms),
      MCP_DAEMON_CONNECT_TIMEOUT_MS: String(options.daemon_connect_timeout_ms),
      MCP_DAEMON_STATE_PATH: options.daemon_state_path,
      MCP_AUTH_TOKEN: options.env.MCP_AUTH_TOKEN,
      MCP_AUTH_AUTO: options.env.MCP_AUTH_AUTO,
    });

    health = await wait_for_daemon_health(options.daemon_host, options.daemon_port, options.daemon_connect_timeout_ms);
  }

  if (!health) {
    throw new Error(
      `shared daemon unavailable at ${options.daemon_host}:${options.daemon_port}; ` +
        `set MCP_DAEMON_MODE=daemon to launch explicitly or use MCP_DAEMON_MODE=direct for legacy behavior`,
    );
  }

  if (health.bridge_port !== options.runtime_options.bridge_port) {
    throw new Error(
      `daemon bridge port mismatch: daemon reports ${health.bridge_port}, requested ${options.runtime_options.bridge_port}; ` +
        `set MCP_DAEMON_PORT or MCP_DAEMON_MODE=direct to avoid mixed runtimes`,
    );
  }

  await start_proxy_runtime(options, health);
}
