import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

interface running_server {
  process: ChildProcessWithoutNullStreams;
  send_request: (id: string | number, method: string, params?: Record<string, unknown>) => Promise<json_rpc_response>;
  send_notification: (method: string, params?: Record<string, unknown>) => void;
  stop: () => Promise<void>;
}

const running_servers: running_server[] = [];
const project_root = resolve(import.meta.dir, "../..");
const package_version = (
  JSON.parse(readFileSync(resolve(project_root, "package.json"), "utf8")) as { version?: string }
).version;
if (typeof package_version !== "string" || package_version.length === 0) {
  throw new Error("package.json version must be set for protocol compatibility tests");
}

function start_stdio_server(): running_server {
  const child_process = spawn("bun", ["run", "src/index.ts"], {
    cwd: project_root,
    env: {
      ...process.env,
      BRIDGE_MODE: "in_memory",
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: "37777",
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
      if (resolver) {
        pending_by_id.delete(key);
        resolver(parsed);
      }
    }
  });

  const send_request = (id: string | number, method: string, params: Record<string, unknown> = {}) => {
    return new Promise<json_rpc_response>((resolve_response, reject_response) => {
      const key = String(id);
      pending_by_id.set(key, resolve_response);

      const timeout = setTimeout(() => {
        pending_by_id.delete(key);
        reject_response(new Error(`timed out waiting for JSON-RPC response id=${key}`));
      }, 10_000);

      const wrapped_resolve = (response: json_rpc_response) => {
        clearTimeout(timeout);
        resolve_response(response);
      };

      pending_by_id.set(key, wrapped_resolve);
      child_process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  const send_notification = (method: string, params: Record<string, unknown> = {}) => {
    child_process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
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
      }, 1500);
    });
  };

  const server = {
    process: child_process,
    send_request,
    send_notification,
    stop,
  };
  running_servers.push(server);
  return server;
}

afterEach(async () => {
  while (running_servers.length > 0) {
    const server = running_servers.pop();
    if (!server) {
      continue;
    }

    await server.stop();
  }
});

test("stdio initialize responds with MCP-compatible shape", async () => {
  const server = start_stdio_server();

  const initialize_response = await server.send_request("init-1", "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "protocol-test-client",
      version: "0.0.1",
    },
  });

  expect(initialize_response.error).toBeUndefined();
  expect(initialize_response.result?.protocolVersion).toBe("2024-11-05");
  expect(initialize_response.result?.capabilities).toMatchObject({
    tools: {
      listChanged: false,
    },
  });
  expect(initialize_response.result?.serverInfo).toMatchObject({
    name: "local-mcp",
    version: package_version,
  });
  expect(typeof initialize_response.result?.agent_session_id).toBe("string");

  server.send_notification("notifications/initialized");
});

test("tools/call works without explicit agent_session_id after initialize", async () => {
  const server = start_stdio_server();

  await server.send_request("init-2", "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "tool-call-test-client",
      version: "0.0.1",
    },
  });

  const list_tabs_response = await server.send_request("tool-1", "tools/call", {
    name: "list_available_tabs",
    arguments: {},
  });

  expect(list_tabs_response.error).toBeUndefined();
  expect(Array.isArray(list_tabs_response.result?.content)).toBe(true);
  expect(typeof list_tabs_response.result?.structuredContent).toBe("object");
  expect(list_tabs_response.result?.structuredContent).not.toBeNull();

  const unknown_tool_response = await server.send_request("tool-2", "tools/call", {
    name: "definitely_not_a_real_tool",
    arguments: {},
  });

  expect(unknown_tool_response.error).toBeUndefined();
  expect(unknown_tool_response.result?.isError).toBe(true);
  expect(Array.isArray(unknown_tool_response.result?.content)).toBe(true);
});
