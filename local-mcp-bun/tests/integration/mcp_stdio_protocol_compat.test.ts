import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mcp_protocol_session } from "../../src/mcp_protocol_session";
import { local_mcp_runtime } from "../../src/runtime";

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
  send_request: (id: string | number, method: string, params?: Record<string, unknown>) => Promise<json_rpc_response>;
  send_notification: (method: string, params?: Record<string, unknown>) => void;
  stop: () => Promise<void>;
}

const running_servers: running_server[] = [];
function parse_test_bridge_port(): number {
  const parsed_port = Number.parseInt(process.env.LOCAL_MCP_TEST_BRIDGE_PORT ?? "37777", 10);
  return Number.isInteger(parsed_port) && parsed_port > 0 && parsed_port <= 65535 ? parsed_port : 37777;
}

const test_bridge_port = parse_test_bridge_port();
const project_root = resolve(import.meta.dir, "../..");
const package_version = (
  JSON.parse(readFileSync(resolve(project_root, "package.json"), "utf8")) as { version?: string }
).version;
if (typeof package_version !== "string" || package_version.length === 0) {
  throw new Error("package.json version must be set for protocol compatibility tests");
}

function start_stdio_server(): running_server {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });
  const pending_by_id = new Map<string, (response: json_rpc_response) => void>();
  const session = new mcp_protocol_session({
    runtime,
    write_response(response) {
      const key = String(response.id);
      const resolver = pending_by_id.get(key);
      if (!resolver) {
        return;
      }

      pending_by_id.delete(key);
      resolver(response);
    },
  });

  const send_request = (id: string | number, method: string, params: Record<string, unknown> = {}) => {
    return new Promise<json_rpc_response>((resolve_response, reject_response) => {
      const key = String(id);
      const timeout = setTimeout(() => {
        pending_by_id.delete(key);
        reject_response(new Error(`timed out waiting for JSON-RPC response id=${key}`));
      }, 10_000);

      const wrapped_resolve = (response: json_rpc_response) => {
        clearTimeout(timeout);
        resolve_response(response);
      };

      pending_by_id.set(key, wrapped_resolve);
      void session
        .handle_line(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
        .catch((error) => {
          clearTimeout(timeout);
          pending_by_id.delete(key);
          reject_response(error);
        });
    });
  };

  const send_notification = (method: string, params: Record<string, unknown> = {}) => {
    void session.handle_line(JSON.stringify({ jsonrpc: "2.0", method, params }));
  };

  const stop = async () => {
    await session.close();
    await runtime.stop();
  };

  const server = {
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

test("tools/call returns MCP image content for browser_take_screenshot", async () => {
  const server = start_stdio_server();

  await server.send_request("init-3", "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "tool-call-screenshot-client",
      version: "0.0.1",
    },
  });

  const attach_response = await server.send_request("tool-attach-1", "tools/call", {
    name: "attach_to_tab",
    arguments: {
      tab_id: 101,
    },
  });

  expect(attach_response.error).toBeUndefined();

  const screenshot_response = await server.send_request("tool-screenshot-1", "tools/call", {
    name: "browser_take_screenshot",
    arguments: {
      type: "png",
      fullPage: true,
    },
  });

  expect(screenshot_response.error).toBeUndefined();
  expect(Array.isArray(screenshot_response.result?.content)).toBe(true);
  expect(screenshot_response.result?.content?.[0]).toMatchObject({
    type: "image",
    mimeType: "image/png",
  });
  expect(typeof screenshot_response.result?.content?.[0]?.data).toBe("string");
  expect((screenshot_response.result?.content?.[0]?.data as string).length).toBeGreaterThan(0);
  expect(screenshot_response.result?.structuredContent).toMatchObject({
    has_image: true,
    mime_type: "image/png",
    capture_mode: "full_page",
    full_page: true,
  });
});
