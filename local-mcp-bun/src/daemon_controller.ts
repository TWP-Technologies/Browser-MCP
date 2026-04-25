// Modified by [KnotFalse]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { is_loopback_host, resolve_auth_token } from "./config";
import { daemon_ingress_server, type daemon_health_snapshot } from "./daemon_ingress_server";
import { mcp_stdio_server } from "./mcp_stdio_server";
import { local_mcp_runtime, type runtime_options } from "./runtime";
import { stdio_proxy_server } from "./stdio_proxy_server";

interface daemon_auth_resolution {
  auth_token?: string;
  generated_automatically: boolean;
  auto_requested: boolean;
}

export interface daemon_state_record {
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
  artifact_root_token?: string;
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

interface daemon_spawn_target {
  command: string;
  args: string[];
}

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
  const state_dir = dirname(path);
  const tmp_path = join(state_dir, `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  mkdirSync(state_dir, { recursive: true });

  try {
    writeFileSync(tmp_path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp_path, path);
  } catch (error) {
    rmSync(tmp_path, { force: true });
    throw error;
  }
}

function sleep(timeout_ms: number): Promise<void> {
  return new Promise((resolve_promise) => {
    setTimeout(resolve_promise, timeout_ms);
  });
}

function remaining_timeout_ms(deadline_ms: number): number {
  return Math.max(0, deadline_ms - Date.now());
}

function build_token_hint(token: string): string {
  if (token.length <= 12) {
    return `${token.slice(0, 2)}***`;
  }

  return `${token.slice(0, 8)}***`;
}

function build_artifact_root_token(): string {
  return `artifact-root-${crypto.randomUUID()}`;
}

function resolve_client_artifact_root_attachment_override(env: Record<string, string | undefined>): boolean | undefined {
  const configured = get_non_empty_string(env.MCP_ATTACH_CLIENT_ARTIFACT_ROOT)?.toLowerCase();
  if (configured === "1" || configured === "true") {
    return true;
  }

  if (configured === "0" || configured === "false") {
    return false;
  }

  return undefined;
}

export function should_attach_client_artifact_root_to_daemon(
  daemon_target: Pick<daemon_run_options, "daemon_host">,
  env: Record<string, string | undefined>,
): boolean {
  const configured = resolve_client_artifact_root_attachment_override(env);
  if (typeof configured === "boolean") {
    return configured;
  }

  return is_loopback_host(daemon_target.daemon_host);
}

export interface proxy_artifact_root_attachment {
  attach_client_artifact_root: boolean;
  artifact_root_token?: string;
  missing_artifact_root_token: boolean;
}

function daemon_hosts_match(state_host: string | undefined, target_host: string): boolean {
  if (state_host === target_host) {
    return true;
  }

  return typeof state_host === "string" && is_loopback_host(state_host) && is_loopback_host(target_host);
}

function daemon_state_matches_health(
  daemon_target: Pick<daemon_run_options, "daemon_host">,
  daemon_health: Pick<daemon_health_snapshot, "started_at" | "pid" | "daemon_port" | "bridge_port">,
  daemon_state:
    | { daemon_host?: string; started_at?: string; pid?: number; daemon_port?: number; bridge_port?: number }
    | undefined,
): boolean {
  return (
    typeof daemon_state === "object" &&
    daemon_state !== null &&
    daemon_hosts_match(daemon_state.daemon_host, daemon_target.daemon_host) &&
    daemon_state.started_at === daemon_health.started_at &&
    daemon_state.pid === daemon_health.pid &&
    daemon_state.daemon_port === daemon_health.daemon_port &&
    daemon_state.bridge_port === daemon_health.bridge_port
  );
}

export function resolve_proxy_artifact_root_attachment(
  daemon_target: Pick<daemon_run_options, "daemon_host">,
  daemon_health: Pick<daemon_health_snapshot, "started_at" | "pid" | "daemon_port" | "bridge_port">,
  env: Record<string, string | undefined>,
  daemon_state:
    | {
        daemon_host?: string;
        started_at?: string;
        pid?: number;
        daemon_port?: number;
        bridge_port?: number;
        artifact_root_token?: string;
      }
    | undefined,
): proxy_artifact_root_attachment {
  const requested_attach = should_attach_client_artifact_root_to_daemon(daemon_target, env);
  const artifact_root_token = daemon_state_matches_health(daemon_target, daemon_health, daemon_state)
    ? get_non_empty_string(daemon_state?.artifact_root_token)
    : undefined;

  if (!requested_attach) {
    return {
      attach_client_artifact_root: false,
      missing_artifact_root_token: false,
    };
  }

  if (!artifact_root_token) {
    return {
      attach_client_artifact_root: false,
      missing_artifact_root_token: true,
    };
  }

  return {
    attach_client_artifact_root: true,
    artifact_root_token,
    missing_artifact_root_token: false,
  };
}

export function resolve_proxy_auth_token_for_log(
  daemon_target: Pick<daemon_run_options, "daemon_host">,
  daemon_health: Pick<daemon_health_snapshot, "started_at" | "pid" | "daemon_port" | "bridge_port">,
  env: Record<string, string | undefined>,
  daemon_state:
    | {
        daemon_host?: string;
        started_at?: string;
        pid?: number;
        daemon_port?: number;
        bridge_port?: number;
        auth_token?: string;
      }
    | undefined,
): string | undefined {
  if (!is_auto_auth_requested(env) || !daemon_state_matches_health(daemon_target, daemon_health, daemon_state)) {
    return undefined;
  }

  return get_non_empty_string(daemon_state?.auth_token);
}

function is_auto_auth_requested(env: Record<string, string | undefined>): boolean {
  return get_non_empty_string(env.MCP_AUTH_TOKEN) === "auto" || get_non_empty_string(env.MCP_AUTH_AUTO) === "1";
}

function proxy_needs_matching_daemon_state(
  daemon_target: Pick<daemon_run_options, "daemon_host">,
  daemon_health: Pick<daemon_health_snapshot, "auth_enabled">,
  env: Record<string, string | undefined>,
): boolean {
  return should_attach_client_artifact_root_to_daemon(daemon_target, env) || (daemon_health.auth_enabled && is_auto_auth_requested(env));
}

export async function wait_for_proxy_daemon_state(
  options: Pick<daemon_run_options, "daemon_host" | "daemon_connect_timeout_ms" | "daemon_state_path" | "env">,
  daemon_health: Pick<daemon_health_snapshot, "started_at" | "pid" | "daemon_port" | "bridge_port" | "auth_enabled">,
  timeout_ms = options.daemon_connect_timeout_ms,
): Promise<daemon_state_record | undefined> {
  const daemon_target = { daemon_host: options.daemon_host };
  const needs_matching_state = proxy_needs_matching_daemon_state(daemon_target, daemon_health, options.env);
  let daemon_state = read_daemon_state(options.daemon_state_path);

  if (!needs_matching_state || daemon_state_matches_health(daemon_target, daemon_health, daemon_state)) {
    return daemon_state;
  }

  const started_at = Date.now();
  while (Date.now() - started_at < timeout_ms) {
    await sleep(daemon_health_poll_interval_ms);
    daemon_state = read_daemon_state(options.daemon_state_path);

    if (daemon_state_matches_health(daemon_target, daemon_health, daemon_state)) {
      return daemon_state;
    }
  }

  return daemon_state;
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

    if (
      typeof payload.started_at !== "string" ||
      typeof payload.pid !== "number" ||
      typeof payload.daemon_port !== "number" ||
      typeof payload.bridge_port !== "number"
    ) {
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

export function resolve_daemon_spawn_target(
  exec_path: string,
  argv: string[],
  argv0: string | undefined,
): daemon_spawn_target {
  const script_or_bundle_entry = typeof argv[1] === "string" ? argv[1] : undefined;
  const runtime_args = argv.slice(2);
  const looks_like_bun_compiled_entry =
    typeof script_or_bundle_entry === "string" &&
    (script_or_bundle_entry.includes("/$bunfs/root/") || script_or_bundle_entry.includes("\\$bunfs\\root\\"));
  const running_compiled_binary =
    looks_like_bun_compiled_entry || (typeof argv0 === "string" && argv0.length > 0 && exec_path === argv0);

  if (running_compiled_binary) {
    return {
      command: exec_path,
      args: [...runtime_args],
    };
  }

  if (script_or_bundle_entry && script_or_bundle_entry.length > 0) {
    return {
      command: exec_path,
      args: [script_or_bundle_entry, ...runtime_args],
    };
  }

  return {
    command: exec_path,
    args: argv.slice(1),
  };
}

function spawn_detached_daemon_process(
  daemon_mode: daemon_run_options["daemon_mode"],
  env: Record<string, string | undefined>,
): void {
  if (daemon_mode !== "auto") {
    return;
  }

  const spawn_target = resolve_daemon_spawn_target(process.execPath, process.argv, process.argv0);
  const detached_process = spawn(spawn_target.command, spawn_target.args, {
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
    try {
      write_daemon_state(daemon_state_path, daemon_state);
    } catch (error) {
      console.error(`[daemon] failed to update daemon state during shutdown: ${error}`);
    }
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
  const artifact_root_token = build_artifact_root_token();
  const started_at = new Date().toISOString();
  const runtime = new local_mcp_runtime({
    ...options.runtime_options,
    auth_token: auth.auth_token,
  });

  const state: daemon_state_record = {
    service: "local-mcp-daemon",
    pid: process.pid,
    started_at,
    updated_at: new Date().toISOString(),
    daemon_host: options.daemon_host,
    daemon_port: options.daemon_port,
    bridge_host: options.runtime_options.bridge_host,
    bridge_port: options.runtime_options.bridge_port,
    auth_enabled: typeof auth.auth_token === "string" && auth.auth_token.length > 0,
    auth_auto: auth.auto_requested,
    auth_token: auth.auto_requested ? auth.auth_token : undefined,
    auth_token_hint,
    artifact_root_token,
  };

  let ingress: daemon_ingress_server | undefined;
  try {
    ingress = new daemon_ingress_server({
      runtime,
      daemon_host: options.daemon_host,
      daemon_port: options.daemon_port,
      bridge_host: options.runtime_options.bridge_host,
      bridge_port: options.runtime_options.bridge_port,
      daemon_state_path: options.daemon_state_path,
      idle_timeout_ms: options.daemon_idle_timeout_ms,
      auth_enabled: state.auth_enabled,
      auth_token_hint: state.auth_token_hint,
      artifact_root_token: state.artifact_root_token,
      started_at,
      on_idle_timeout: async () => {
        state.updated_at = new Date().toISOString();
        try {
          write_daemon_state(options.daemon_state_path, state);
        } catch (error) {
          console.error(`[daemon] failed to update daemon state during idle shutdown: ${error}`);
        } finally {
          await ingress?.stop();
          await runtime.stop();
          process.exit(0);
        }
      },
    });
    write_daemon_state(options.daemon_state_path, state);
  } catch (error) {
    await ingress?.stop().catch(() => {
      // ignore cleanup after failed daemon ingress startup
    });
    await runtime.stop().catch(() => {
      // ignore cleanup after failed daemon ingress startup
    });
    throw error;
  }

  if (!ingress) {
    throw new Error("daemon ingress failed to start");
  }

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
  daemon_state: daemon_state_record | undefined,
): Promise<void> {
  const auth_token_for_log = resolve_proxy_auth_token_for_log(
    { daemon_host: options.daemon_host },
    daemon_health,
    options.env,
    daemon_state,
  );

  if (auth_token_for_log) {
    console.error(`[auth] daemon token for initialize.params.token: ${auth_token_for_log}`);
  }

  if (daemon_health.auth_enabled) {
    console.error(`[daemon] connected shared runtime auth hint: ${daemon_health.auth_token_hint ?? "redacted"}`);
  }

  const artifact_root_attachment = resolve_proxy_artifact_root_attachment(
    { daemon_host: options.daemon_host },
    daemon_health,
    options.env,
    daemon_state,
  );
  if (artifact_root_attachment.missing_artifact_root_token) {
    const state_status = daemon_state_matches_health({ daemon_host: options.daemon_host }, daemon_health, daemon_state)
      ? "matching daemon state is missing artifact_root_token"
      : "daemon state file is missing or does not match the running daemon";
    throw new Error(
      `daemon artifact-root token missing or stale: ${state_status}; ` +
        `state_path=${options.daemon_state_path}; daemon_pid=${daemon_health.pid}; started_at=${daemon_health.started_at}; ` +
        "restart the shared daemon, remove the stale daemon state file, or set MCP_ATTACH_CLIENT_ARTIFACT_ROOT=0 to use daemon cwd for artifact paths",
    );
  }

  const proxy_server = new stdio_proxy_server({
    daemon_url: `ws://${options.daemon_host}:${options.daemon_port}/mcp`,
    connect_timeout_ms: options.daemon_connect_timeout_ms,
    attach_client_artifact_root: artifact_root_attachment.attach_client_artifact_root,
    artifact_root_token: artifact_root_attachment.artifact_root_token,
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

  const daemon_connect_deadline_ms = Date.now() + options.daemon_connect_timeout_ms;
  let health = await fetch_daemon_health(
    options.daemon_host,
    options.daemon_port,
    Math.min(daemon_health_request_timeout_ms, remaining_timeout_ms(daemon_connect_deadline_ms)),
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

    health = await wait_for_daemon_health(
      options.daemon_host,
      options.daemon_port,
      remaining_timeout_ms(daemon_connect_deadline_ms),
    );
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

  const daemon_state = await wait_for_proxy_daemon_state(
    options,
    health,
    remaining_timeout_ms(daemon_connect_deadline_ms),
  );
  await start_proxy_runtime(options, health, daemon_state);
}
