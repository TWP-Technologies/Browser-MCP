import { expect, test } from "bun:test";
import { daemon_ingress_server } from "../../src/daemon_ingress_server";
import { local_mcp_runtime } from "../../src/runtime";

interface initialize_response {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: {
    agent_session_id?: string;
  };
}

function random_port(): number {
  return 44500 + Math.floor(Math.random() * 1000);
}

async function wait_for_socket_open(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve_promise, reject_promise) => {
    socket.addEventListener("open", () => {
      resolve_promise();
    });
    socket.addEventListener("error", () => {
      reject_promise(new Error("websocket open failed"));
    });
  });
}

async function wait_for_initialize_response(socket: WebSocket): Promise<initialize_response> {
  return await new Promise<initialize_response>((resolve_promise, reject_promise) => {
    const timeout_id = setTimeout(() => {
      reject_promise(new Error("timed out waiting for initialize response"));
    }, 5_000);

    socket.addEventListener("message", (event) => {
      clearTimeout(timeout_id);
      resolve_promise(JSON.parse(String(event.data)) as initialize_response);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout_id);
      reject_promise(new Error("websocket message failed"));
    });
  });
}

async function wait_for_socket_close(socket: WebSocket): Promise<CloseEvent> {
  return await new Promise<CloseEvent>((resolve_promise, reject_promise) => {
    const timeout_id = setTimeout(() => {
      reject_promise(new Error("timed out waiting for socket close"));
    }, 5_000);

    socket.addEventListener("close", (event) => {
      clearTimeout(timeout_id);
      resolve_promise(event);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout_id);
      reject_promise(new Error("websocket close failed"));
    });
  });
}

test("daemon ingress closes stale bound sockets during cleanup sweeps", async () => {
  const daemon_port = random_port();
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: daemon_port + 1000,
    session_idle_timeout_minutes: 120,
  });

  const ingress = new daemon_ingress_server({
    runtime,
    daemon_host: "127.0.0.1",
    daemon_port,
    bridge_host: "127.0.0.1",
    bridge_port: daemon_port + 1000,
    daemon_state_path: "/tmp/local-mcp-daemon-test.json",
    idle_timeout_ms: 60_000,
    cleanup_interval_ms: 25,
    auth_enabled: false,
    on_idle_timeout: async () => {},
  });

  const socket = new WebSocket(`ws://127.0.0.1:${daemon_port}/mcp`);

  try {
    await wait_for_socket_open(socket);
    socket.send(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "cleanup-test",
            version: "0.0.1",
          },
        },
      })}\n`,
    );

    const initialize_response = await wait_for_initialize_response(socket);
    const agent_session_id = initialize_response.result?.agent_session_id;
    expect(typeof agent_session_id).toBe("string");

    runtime.session_registry.get_session(agent_session_id as string).last_seen_at = new Date(
      Date.now() - 3 * 60 * 60 * 1000,
    ).toISOString();

    const closed_event = await wait_for_socket_close(socket);
    expect(closed_event.reason).toBe("stale_session_timeout");
    expect(runtime.session_registry.list_active_sessions()).toEqual([]);
    expect(ingress.get_health_snapshot().active_proxy_connections).toBe(0);
  } finally {
    try {
      socket.close();
    } catch {
      // ignore best-effort close
    }

    await ingress.stop();
    await runtime.stop();
  }
});

test("daemon ingress closes sockets whose sessions were closed elsewhere", async () => {
  const daemon_port = random_port();
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: daemon_port + 1000,
    session_idle_timeout_minutes: 120,
  });

  const ingress = new daemon_ingress_server({
    runtime,
    daemon_host: "127.0.0.1",
    daemon_port,
    bridge_host: "127.0.0.1",
    bridge_port: daemon_port + 1000,
    daemon_state_path: "/tmp/local-mcp-daemon-test.json",
    idle_timeout_ms: 60_000,
    cleanup_interval_ms: 25,
    auth_enabled: false,
    on_idle_timeout: async () => {},
  });

  const socket = new WebSocket(`ws://127.0.0.1:${daemon_port}/mcp`);

  try {
    await wait_for_socket_open(socket);
    socket.send(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "cleanup-test",
            version: "0.0.1",
          },
        },
      })}\n`,
    );

    const initialize_response = await wait_for_initialize_response(socket);
    const agent_session_id = initialize_response.result?.agent_session_id;
    expect(typeof agent_session_id).toBe("string");

    await runtime.tool_router.close_session(agent_session_id as string);

    const closed_event = await wait_for_socket_close(socket);
    expect(closed_event.reason).toBe("session_closed");
    expect(runtime.session_registry.list_active_sessions()).toEqual([]);
    expect(ingress.get_health_snapshot().active_proxy_connections).toBe(0);
  } finally {
    try {
      socket.close();
    } catch {
      // ignore best-effort close
    }

    await ingress.stop();
    await runtime.stop();
  }
});
