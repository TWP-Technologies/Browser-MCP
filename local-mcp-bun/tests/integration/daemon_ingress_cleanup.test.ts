// Modified by [KnotFalse]
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemon_ingress_server } from "../../src/daemon_ingress_server";
import { local_mcp_runtime } from "../../src/runtime";

interface initialize_response {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: {
    agent_session_id?: string;
    structuredContent?: Record<string, unknown>;
  };
  error?: {
    code: number;
    message: string;
  };
}

function random_port(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

const test_artifact_root_token = "test-artifact-root-token";

async function create_test_ingress(
  cleanup_interval_ms: number,
  options: {
    daemon_host?: string;
    auth_enabled?: boolean;
    auth_token?: string;
  } = {},
): Promise<{
  runtime: local_mcp_runtime;
  ingress: daemon_ingress_server;
  daemon_port: number;
  daemon_state_dir: string;
}> {
  let last_error: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const daemon_port = random_port();
    const bridge_port = random_port();
    const daemon_state_dir = mkdtempSync(join(tmpdir(), "local-mcp-daemon-test-"));
    const daemon_state_path = join(daemon_state_dir, "daemon-state.json");
    const runtime = new local_mcp_runtime({
      bridge_mode: "in_memory",
      bridge_host: "127.0.0.1",
      bridge_port,
      session_idle_timeout_minutes: 120,
      auth_token: options.auth_token,
    });

    try {
      const ingress = new daemon_ingress_server({
        runtime,
        daemon_host: options.daemon_host ?? "127.0.0.1",
        daemon_port,
        bridge_host: "127.0.0.1",
        bridge_port,
        daemon_state_path,
        idle_timeout_ms: 60_000,
        cleanup_interval_ms,
        auth_enabled: options.auth_enabled ?? typeof options.auth_token === "string",
        artifact_root_token: test_artifact_root_token,
        on_idle_timeout: async () => {},
      });

      return { runtime, ingress, daemon_port, daemon_state_dir };
    } catch (error) {
      last_error = error;
      await runtime.stop();
      rmSync(daemon_state_dir, { recursive: true, force: true });
    }
  }

  throw last_error instanceof Error ? last_error : new Error("failed to create daemon ingress");
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

async function wait_for_response(socket: WebSocket, id: string): Promise<initialize_response> {
  return await new Promise<initialize_response>((resolve_promise, reject_promise) => {
    const on_message = (event: MessageEvent): void => {
      const response = JSON.parse(String(event.data)) as initialize_response;
      if (response.id !== id) {
        return;
      }

      clearTimeout(timeout_id);
      socket.removeEventListener("message", on_message);
      socket.removeEventListener("error", on_error);
      resolve_promise(response);
    };
    const on_error = (): void => {
      clearTimeout(timeout_id);
      socket.removeEventListener("message", on_message);
      socket.removeEventListener("error", on_error);
      reject_promise(new Error("websocket message failed"));
    };
    const timeout_id = setTimeout(() => {
      socket.removeEventListener("message", on_message);
      socket.removeEventListener("error", on_error);
      reject_promise(new Error(`timed out waiting for response ${id}`));
    }, 5_000);

    socket.addEventListener("message", on_message);
    socket.addEventListener("error", on_error);
  });
}

async function wait_for_condition(predicate: () => boolean, timeout_ms = 5_000, interval_ms = 25): Promise<void> {
  const started_at = Date.now();

  while (Date.now() - started_at < timeout_ms) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve_promise) => {
      setTimeout(resolve_promise, interval_ms);
    });
  }

  throw new Error("timed out waiting for condition");
}

test("daemon ingress soft-reaps stale bound sessions without closing the socket", async () => {
  const { runtime, ingress, daemon_port, daemon_state_dir } = await create_test_ingress(25);

  const socket = new WebSocket(`ws://127.0.0.1:${daemon_port}/mcp`);
  let close_event: CloseEvent | null = null;
  socket.addEventListener("close", (event) => {
    close_event = event;
  });

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
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    runtime.session_registry.get_session(agent_session_id).last_seen_at = new Date(
      Date.now() - 3 * 60 * 60 * 1000,
    ).toISOString();

    await wait_for_condition(
      () => typeof runtime.session_registry.get_session(agent_session_id).resource_reaped_at === "string",
    );

    expect(close_event).toBeNull();
    expect(runtime.session_registry.list_active_sessions()).toEqual([agent_session_id]);
    expect(ingress.get_health_snapshot().active_proxy_connections).toBe(1);

    socket.send(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "tabs",
        method: "tools/call",
        params: {
          name: "list_available_tabs",
          arguments: {},
        },
      })}\n`,
    );

    const tabs_response = await wait_for_response(socket, "tabs");
    const structured_content = tabs_response.result?.structuredContent;
    expect(Array.isArray(structured_content?.tabs)).toBe(true);
    expect(runtime.session_registry.get_session(agent_session_id).resource_reaped_at).toBeUndefined();
    expect(close_event).toBeNull();
  } finally {
    try {
      socket.close();
    } catch {
      // ignore best-effort close
    }

    await ingress.stop();
    await runtime.stop();
    rmSync(daemon_state_dir, { recursive: true, force: true });
  }
});

test("daemon ingress resolves relative artifact paths against connection artifact root", async () => {
  const { runtime, ingress, daemon_port, daemon_state_dir } = await create_test_ingress(25);
  const artifact_root_dir = mkdtempSync(join(tmpdir(), "local-mcp-client-artifacts-"));

  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon_port}/mcp?client_artifact_root=${encodeURIComponent(
      artifact_root_dir,
    )}&client_artifact_root_token=${encodeURIComponent(test_artifact_root_token)}`,
  );

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
            name: "artifact-root-test",
            version: "0.0.1",
          },
        },
      })}\n`,
    );

    const initialize_response = await wait_for_initialize_response(socket);
    expect(initialize_response.error).toBeUndefined();
    expect(typeof initialize_response.result?.agent_session_id).toBe("string");

    socket.send(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "attach",
        method: "tools/call",
        params: {
          name: "attach_to_tab",
          arguments: {
            tab_id: 101,
          },
        },
      })}\n`,
    );
    const attach_response = await wait_for_response(socket, "attach");
    expect(attach_response.error).toBeUndefined();

    socket.send(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "screenshot",
        method: "tools/call",
        params: {
          name: "browser_take_screenshot",
          arguments: {
            type: "png",
            path: "captures/daemon.png",
          },
        },
      })}\n`,
    );
    const screenshot_response = await wait_for_response(socket, "screenshot");
    expect(screenshot_response.error).toBeUndefined();

    const expected_path = join(artifact_root_dir, "captures/daemon.png");
    expect(screenshot_response.result?.structuredContent?.path).toBe(expected_path);
    expect(readFileSync(expected_path).byteLength).toBeGreaterThan(0);
  } finally {
    try {
      socket.close();
    } catch {
      // ignore best-effort close
    }

    await ingress.stop();
    await runtime.stop();
    rmSync(artifact_root_dir, { recursive: true, force: true });
    rmSync(daemon_state_dir, { recursive: true, force: true });
  }
});

test("daemon ingress rejects relative client artifact roots", async () => {
  const { runtime, ingress, daemon_port, daemon_state_dir } = await create_test_ingress(25);

  try {
    const response = await fetch(
      `http://127.0.0.1:${daemon_port}/mcp?client_artifact_root=relative-root&client_artifact_root_token=${encodeURIComponent(
        test_artifact_root_token,
      )}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("absolute path");
  } finally {
    await ingress.stop();
    await runtime.stop();
    rmSync(daemon_state_dir, { recursive: true, force: true });
  }
});

test("daemon ingress rejects client artifact roots without the daemon-issued root token", async () => {
  const { runtime, ingress, daemon_port, daemon_state_dir } = await create_test_ingress(25);
  const artifact_root_dir = mkdtempSync(join(tmpdir(), "local-mcp-client-artifacts-"));

  try {
    const response = await fetch(
      `http://127.0.0.1:${daemon_port}/mcp?client_artifact_root=${encodeURIComponent(artifact_root_dir)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("daemon-issued artifact root token");
  } finally {
    await ingress.stop();
    await runtime.stop();
    rmSync(artifact_root_dir, { recursive: true, force: true });
    rmSync(daemon_state_dir, { recursive: true, force: true });
  }
});

test("daemon ingress rejects missing client artifact roots with descriptive message", async () => {
  const { runtime, ingress, daemon_port, daemon_state_dir } = await create_test_ingress(25);
  const parent_dir = mkdtempSync(join(tmpdir(), "local-mcp-missing-root-parent-"));
  const missing_root = join(parent_dir, "missing-root");

  try {
    const response = await fetch(
      `http://127.0.0.1:${daemon_port}/mcp?client_artifact_root=${encodeURIComponent(
        missing_root,
      )}&client_artifact_root_token=${encodeURIComponent(test_artifact_root_token)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`artifact root must be an existing directory: ${missing_root}`);
  } finally {
    await ingress.stop();
    await runtime.stop();
    rmSync(parent_dir, { recursive: true, force: true });
    rmSync(daemon_state_dir, { recursive: true, force: true });
  }
});

test("daemon ingress rejects client artifact roots on unauthenticated non-loopback ingress", async () => {
  const { runtime, ingress, daemon_port, daemon_state_dir } = await create_test_ingress(25, {
    daemon_host: "0.0.0.0",
  });
  const artifact_root_dir = mkdtempSync(join(tmpdir(), "local-mcp-client-artifacts-"));

  try {
    const response = await fetch(
      `http://127.0.0.1:${daemon_port}/mcp?client_artifact_root=${encodeURIComponent(
        artifact_root_dir,
      )}&client_artifact_root_token=${encodeURIComponent(test_artifact_root_token)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("client_artifact_root requires loopback daemon ingress or MCP auth");
  } finally {
    await ingress.stop();
    await runtime.stop();
    rmSync(artifact_root_dir, { recursive: true, force: true });
    rmSync(daemon_state_dir, { recursive: true, force: true });
  }
});

test("daemon ingress defers non-loopback artifact root filesystem checks until initialize auth", async () => {
  const { runtime, ingress, daemon_port, daemon_state_dir } = await create_test_ingress(25, {
    daemon_host: "0.0.0.0",
    auth_token: "secret-token",
  });
  const parent_dir = mkdtempSync(join(tmpdir(), "local-mcp-deferred-root-parent-"));
  const missing_root = join(parent_dir, "missing-root");
  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon_port}/mcp?client_artifact_root=${encodeURIComponent(
      missing_root,
    )}&client_artifact_root_token=${encodeURIComponent(test_artifact_root_token)}`,
  );

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
            name: "deferred-artifact-root-test",
            version: "0.0.1",
          },
          token: "wrong-token",
        },
      })}\n`,
    );

    const initialize_response = await wait_for_initialize_response(socket);
    expect(initialize_response.error?.message).toBe("invalid token");
  } finally {
    try {
      socket.close();
    } catch {
      // ignore best-effort close
    }

    await ingress.stop();
    await runtime.stop();
    rmSync(parent_dir, { recursive: true, force: true });
    rmSync(daemon_state_dir, { recursive: true, force: true });
  }
});

test("daemon ingress lets live sockets rebind when their session was closed elsewhere", async () => {
  const { runtime, ingress, daemon_port, daemon_state_dir } = await create_test_ingress(25);

  const socket = new WebSocket(`ws://127.0.0.1:${daemon_port}/mcp`);
  let close_event: CloseEvent | null = null;
  socket.addEventListener("close", (event) => {
    close_event = event;
  });

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
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    const ingress_internals = ingress as unknown as {
      agent_session_id_by_connection_id: Map<number, string>;
      last_activity_at_ms_by_connection_id: Map<number, number>;
      run_cleanup_tick: () => Promise<void>;
    };
    const connection_id = [...ingress_internals.agent_session_id_by_connection_id.entries()].find(
      ([, mapped_agent_session_id]) => mapped_agent_session_id === agent_session_id,
    )?.[0];
    if (typeof connection_id !== "number") {
      throw new Error("expected bound daemon connection");
    }

    await runtime.tool_router.close_session(agent_session_id);
    ingress_internals.last_activity_at_ms_by_connection_id.set(connection_id, Date.now() - 3 * 60 * 60 * 1000);
    const before_cleanup_ms = Date.now();
    await ingress_internals.run_cleanup_tick();

    expect(ingress_internals.agent_session_id_by_connection_id.has(connection_id)).toBe(false);
    expect(ingress_internals.last_activity_at_ms_by_connection_id.get(connection_id)).toBeGreaterThanOrEqual(
      before_cleanup_ms,
    );
    await ingress_internals.run_cleanup_tick();
    expect(close_event).toBeNull();
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.send(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "tabs-after-close",
        method: "tools/call",
        params: {
          name: "list_available_tabs",
          arguments: {},
        },
      })}\n`,
    );

    const tabs_response = await wait_for_response(socket, "tabs-after-close");
    const structured_content = tabs_response.result?.structuredContent;
    const active_sessions = runtime.session_registry.list_active_sessions();

    expect(Array.isArray(structured_content?.tabs)).toBe(true);
    expect(active_sessions).toHaveLength(1);
    expect(active_sessions[0]).not.toBe(agent_session_id);
    expect(close_event).toBeNull();
    expect(ingress.get_health_snapshot().active_proxy_connections).toBe(1);
  } finally {
    try {
      socket.close();
    } catch {
      // ignore best-effort close
    }

    await ingress.stop();
    await runtime.stop();
    rmSync(daemon_state_dir, { recursive: true, force: true });
  }
});
