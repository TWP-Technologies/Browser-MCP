import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface json_rpc_response {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface daemon_health_payload {
  service: string;
  pid: number;
  daemon_port: number;
  bridge_port: number;
  active_proxy_connections: number;
  active_sessions?: number;
  stale_session_timeout_minutes?: number;
}

interface running_client {
  process: ChildProcessWithoutNullStreams;
  send_request: (id: string | number, method: string, params?: Record<string, unknown>) => Promise<json_rpc_response>;
  stop: () => Promise<void>;
}

const project_root = resolve(import.meta.dir, "../..");
const running_clients: running_client[] = [];
const daemon_state_dirs: string[] = [];

function random_port(): number {
  return 42000 + Math.floor(Math.random() * 2000);
}

function sleep(timeout_ms: number): Promise<void> {
  return new Promise((resolve_promise) => {
    setTimeout(resolve_promise, timeout_ms);
  });
}

async function wait_for_condition(
  predicate: () => boolean | Promise<boolean>,
  timeout_ms = 10_000,
  interval_ms = 100,
): Promise<void> {
  const started_at = Date.now();
  while (Date.now() - started_at < timeout_ms) {
    if (await predicate()) {
      return;
    }

    await sleep(interval_ms);
  }

  throw new Error(`timed out after ${timeout_ms}ms waiting for condition`);
}

async function fetch_daemon_health(daemon_port: number): Promise<daemon_health_payload | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${daemon_port}/health`);
    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as Partial<daemon_health_payload>;
    if (payload.service !== "local-mcp-daemon") {
      return undefined;
    }

    if (typeof payload.pid !== "number" || typeof payload.active_proxy_connections !== "number") {
      return undefined;
    }

    return payload as daemon_health_payload;
  } catch {
    return undefined;
  }
}

function start_client(env: Record<string, string>): running_client {
  const child_process = spawn("bun", ["run", "src/index.ts"], {
    cwd: project_root,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child_process.stdout.setEncoding("utf8");
  child_process.stderr.setEncoding("utf8");

  let line_buffer = "";
  const pending_by_id = new Map<string, (response: json_rpc_response) => void>();

  child_process.stdout.on("data", (chunk: string) => {
    line_buffer += chunk;
    while (true) {
      const next_newline_index = line_buffer.indexOf("\n");
      if (next_newline_index < 0) {
        return;
      }

      const line = line_buffer.slice(0, next_newline_index).trim();
      line_buffer = line_buffer.slice(next_newline_index + 1);
      if (line.length === 0) {
        continue;
      }

      const parsed = JSON.parse(line) as json_rpc_response;
      const key = String(parsed.id);
      const resolver = pending_by_id.get(key);
      if (!resolver) {
        continue;
      }

      pending_by_id.delete(key);
      resolver(parsed);
    }
  });

  const send_request = (id: string | number, method: string, params: Record<string, unknown> = {}) => {
    return new Promise<json_rpc_response>((resolve_response, reject_response) => {
      const key = String(id);
      const timeout_id = setTimeout(() => {
        pending_by_id.delete(key);
        reject_response(new Error(`timed out waiting for json-rpc response id=${key}`));
      }, 20_000);

      pending_by_id.set(key, (response) => {
        clearTimeout(timeout_id);
        resolve_response(response);
      });

      child_process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const stop = async () => {
    child_process.stdin.end();
    await new Promise<void>((resolve_done) => {
      if (child_process.exitCode !== null) {
        resolve_done();
        return;
      }

      child_process.once("exit", () => {
        resolve_done();
      });

      setTimeout(() => {
        if (child_process.exitCode === null) {
          child_process.kill("SIGTERM");
        }
      }, 2_000);
    });
  };

  const client = {
    process: child_process,
    send_request,
    stop,
  };

  running_clients.push(client);
  return client;
}

afterEach(async () => {
  while (running_clients.length > 0) {
    const client = running_clients.pop();
    if (!client) {
      continue;
    }

    await client.stop();
  }

  while (daemon_state_dirs.length > 0) {
    const state_dir = daemon_state_dirs.pop();
    if (!state_dir) {
      continue;
    }

    rmSync(state_dir, { recursive: true, force: true });
  }
});

test("auto mode multiplexes two stdio clients through a single shared daemon", async () => {
  const bridge_port = random_port();
  const daemon_port = bridge_port + 1;
  const daemon_state_dir = mkdtempSync(join(tmpdir(), "local-mcp-bun-daemon-state-"));
  const daemon_state_path = join(daemon_state_dir, "daemon-state.json");
  daemon_state_dirs.push(daemon_state_dir);

  const base_env = {
    BRIDGE_MODE: "websocket",
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: String(bridge_port),
    MCP_DAEMON_MODE: "auto",
    MCP_DAEMON_PORT: String(daemon_port),
    MCP_DAEMON_IDLE_TIMEOUT_MS: "2000",
    MCP_DAEMON_CONNECT_TIMEOUT_MS: "20000",
    MCP_DAEMON_STATE_PATH: daemon_state_path,
  };

  const client_a = start_client(base_env);
  const client_b = start_client(base_env);

  const [init_a, init_b] = await Promise.all([
    client_a.send_request("init-a", "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "daemon-test-a",
        version: "0.0.1",
      },
    }),
    client_b.send_request("init-b", "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "daemon-test-b",
        version: "0.0.1",
      },
    }),
  ]);

  expect(init_a.error).toBeUndefined();
  expect(init_b.error).toBeUndefined();
  const session_a = init_a.result?.agent_session_id;
  const session_b = init_b.result?.agent_session_id;
  expect(typeof session_a).toBe("string");
  expect(typeof session_b).toBe("string");
  expect(session_a).not.toBe(session_b);

  const sessions_response = await client_a.send_request("sessions-a", "sessions/list", {});
  expect(sessions_response.error).toBeUndefined();
  const sessions = sessions_response.result?.sessions;
  expect(Array.isArray(sessions)).toBe(true);
  expect((sessions as string[]).includes(session_a as string)).toBe(true);
  expect((sessions as string[]).includes(session_b as string)).toBe(true);

  const daemon_health = await fetch_daemon_health(daemon_port);
  expect(daemon_health?.service).toBe("local-mcp-daemon");
  expect(daemon_health?.bridge_port).toBe(bridge_port);
  expect((daemon_health?.active_proxy_connections ?? 0) >= 2).toBe(true);
  expect((daemon_health?.active_sessions ?? 0) >= 2).toBe(true);
  expect(daemon_health?.stale_session_timeout_minutes).toBe(120);
  expect(client_a.process.exitCode).toBeNull();
  expect(client_b.process.exitCode).toBeNull();

  await client_a.stop();
  await client_b.stop();

  await wait_for_condition(async () => {
    const health = await fetch_daemon_health(daemon_port);
    return typeof health === "undefined";
  }, 15_000, 250);
});
