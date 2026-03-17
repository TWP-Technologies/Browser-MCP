import { expect, test } from "bun:test";
import { local_mcp_runtime } from "../../src/runtime";
import { in_memory_bridge_transport } from "../../src/bridge_transport";
import { tool_error } from "../../src/errors";

const test_bridge_port = Number.parseInt(process.env.LOCAL_MCP_TEST_BRIDGE_PORT ?? "37777", 10);

test("tool_router lists tabs and lock metadata", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const { agent_session_id } = runtime.tool_router.open_session("test-client");
  const list_result = await runtime.tool_router.call_tool(agent_session_id, "list_available_tabs", {});
  const tabs = list_result.tabs as Array<Record<string, unknown>>;

  expect(Array.isArray(tabs)).toBe(true);
  expect(tabs.length).toBeGreaterThan(0);
  expect(tabs[0]?.is_locked_by_agent).toBe(false);

  await runtime.stop();
});

test("attach_to_tab enforces lock conflict and detach handoff", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const a = runtime.tool_router.open_session("agent-a").agent_session_id;
  const b = runtime.tool_router.open_session("agent-b").agent_session_id;

  const attach_a = await runtime.tool_router.call_tool(a, "attach_to_tab", { tab_id: 101 });
  expect(attach_a.owner_agent_session_id).toBe(a);

  try {
    await runtime.tool_router.call_tool(b, "attach_to_tab", { tab_id: 101 });
    throw new Error("expected conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("LOCK_CONFLICT");
  }

  await runtime.tool_router.call_tool(a, "detach_from_tab", { tab_id: 101 });
  const attach_b = await runtime.tool_router.call_tool(b, "attach_to_tab", { tab_id: 101 });
  expect(attach_b.owner_agent_session_id).toBe(b);

  await runtime.stop();
});

test("attach_to_tab supports wait_timeout_ms lock acquisition", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const a = runtime.tool_router.open_session("agent-a").agent_session_id;
  const b = runtime.tool_router.open_session("agent-b").agent_session_id;

  await runtime.tool_router.call_tool(a, "attach_to_tab", { tab_id: 102 });

  const waiting_attach = runtime.tool_router.call_tool(b, "attach_to_tab", {
    tab_id: 102,
    wait_timeout_ms: 1000,
  });

  setTimeout(() => {
    runtime.tool_router.call_tool(a, "detach_from_tab", { tab_id: 102 }).catch(() => {
      // detach should succeed in test
    });
  }, 50);

  const attach_result = await waiting_attach;
  expect(attach_result.owner_agent_session_id).toBe(b);

  await runtime.stop();
});

test("browser_tabs new assigns lock and enables tab-scoped tool routing", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const session_id = runtime.tool_router.open_session("agent-a").agent_session_id;

  const create_result = await runtime.tool_router.call_tool(session_id, "browser_tabs", {
    action: "new",
    url: "https://example.org",
  });

  expect(create_result.action).toBe("new");
  expect(typeof create_result.tab_id).toBe("number");

  const navigate_result = await runtime.tool_router.call_tool(session_id, "browser_navigate", {
    action: "url",
    url: "https://bun.sh",
  });

  expect(navigate_result.url).toBe("https://bun.sh");

  await runtime.stop();
});

test("tab-scoped tools fail when no active tab lock is owned", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const session_id = runtime.tool_router.open_session("agent-a").agent_session_id;

  try {
    await runtime.tool_router.call_tool(session_id, "browser_snapshot", {});
    throw new Error("expected active tab validation error");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("INVALID_ARGUMENT");
  }

  await runtime.stop();
});

test("tab-scoped browser_pdf_save returns encoded payload when attached", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const session_id = runtime.tool_router.open_session("agent-a").agent_session_id;
  await runtime.tool_router.call_tool(session_id, "attach_to_tab", { tab_id: 101 });

  const pdf_result = await runtime.tool_router.call_tool(session_id, "browser_pdf_save", {});
  expect(typeof pdf_result.data_base64).toBe("string");
  expect(Number(pdf_result.bytes)).toBeGreaterThan(0);

  await runtime.stop();
});

test("tab-scoped browser_take_screenshot returns image payload metadata when attached", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const session_id = runtime.tool_router.open_session("agent-a").agent_session_id;
  await runtime.tool_router.call_tool(session_id, "attach_to_tab", { tab_id: 101 });

  const screenshot_result = await runtime.tool_router.call_tool(session_id, "browser_take_screenshot", {
    type: "png",
    fullPage: true,
  });

  expect(typeof screenshot_result.data_base64).toBe("string");
  expect(screenshot_result.mime_type).toBe("image/png");
  expect(Number(screenshot_result.bytes)).toBeGreaterThan(0);
  expect(screenshot_result.capture_mode).toBe("full_page");
  expect(screenshot_result.full_page).toBe(true);

  await runtime.stop();
});

test("open_session enforces optional auth token when configured", () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
    auth_token: "secret-token",
  });

  expect(() => runtime.tool_router.open_session("agent-a", "wrong-token")).toThrow();
  const session = runtime.tool_router.open_session("agent-a", "secret-token");
  expect(session.agent_session_id.length).toBeGreaterThan(0);
});

test("bridge request envelope preserves agent_session_id across concurrent sessions", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  bridge.clear_request_log_for_tests();

  const session_a = runtime.tool_router.open_session("agent-a").agent_session_id;
  const session_b = runtime.tool_router.open_session("agent-b").agent_session_id;

  await runtime.tool_router.call_tool(session_a, "list_available_tabs", {});
  await runtime.tool_router.call_tool(session_a, "attach_to_tab", { tab_id: 101 });
  await runtime.tool_router.call_tool(session_a, "browser_snapshot", {});

  await runtime.tool_router.call_tool(session_b, "list_available_tabs", {});
  await runtime.tool_router.call_tool(session_b, "attach_to_tab", { tab_id: 102 });
  await runtime.tool_router.call_tool(session_b, "browser_snapshot", {});

  const request_log = bridge.get_request_log_for_tests();
  const list_calls = request_log.filter((entry) => entry.action === "list_tabs");
  const attach_calls = request_log.filter((entry) => entry.action === "attach_to_tab");
  const snapshot_calls = request_log.filter((entry) => {
    if (entry.action !== "call_tool") {
      return false;
    }

    return (entry.payload.tool_name as string | undefined) === "browser_snapshot";
  });

  expect(list_calls.some((entry) => entry.agent_session_id === session_a)).toBe(true);
  expect(list_calls.some((entry) => entry.agent_session_id === session_b)).toBe(true);
  expect(attach_calls.some((entry) => entry.agent_session_id === session_a)).toBe(true);
  expect(attach_calls.some((entry) => entry.agent_session_id === session_b)).toBe(true);
  expect(snapshot_calls.some((entry) => entry.agent_session_id === session_a)).toBe(true);
  expect(snapshot_calls.some((entry) => entry.agent_session_id === session_b)).toBe(true);
  expect(request_log.some((entry) => entry.agent_session_id.startsWith("system-router:"))).toBe(true);

  await runtime.stop();
});

test("tool_router publishes connections snapshots with sessions and locks", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  expect(bridge.get_last_connections_snapshot_for_tests()).toBe(null);

  const session_id = runtime.tool_router.open_session("snapshot-agent").agent_session_id;
  const after_open = bridge.get_last_connections_snapshot_for_tests();
  expect(after_open?.sessions.some((session) => session.agent_session_id === session_id)).toBe(true);
  expect(after_open?.locks.length).toBe(0);

  await runtime.tool_router.call_tool(session_id, "attach_to_tab", { tab_id: 101 });
  const after_attach = bridge.get_last_connections_snapshot_for_tests();
  expect(after_attach?.locks.some((lock) => lock.tab_id === 101 && lock.owner_agent_session_id === session_id)).toBe(true);

  await runtime.tool_router.call_tool(session_id, "detach_from_tab", { tab_id: 101 });
  const after_detach = bridge.get_last_connections_snapshot_for_tests();
  expect(after_detach?.locks.some((lock) => lock.tab_id === 101)).toBe(false);

  await runtime.stop();
});

test("ui admin close_session releases locks and returns response", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  const session_id = runtime.tool_router.open_session("admin-close").agent_session_id;
  await runtime.tool_router.call_tool(session_id, "attach_to_tab", { tab_id: 101 });

  const response = await bridge.emit_ui_admin_request_for_tests("close_session", {
    agent_session_id: session_id,
  });

  expect(response.ok).toBe(true);
  expect(runtime.session_registry.list_active_sessions().includes(session_id)).toBe(false);
  expect(runtime.tab_lock_manager.get_lock(101)).toBeUndefined();

  await runtime.stop();
});

test("ui admin close_all_sessions closes every active session", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  const first_session_id = runtime.tool_router.open_session("admin-close-all-a").agent_session_id;
  const second_session_id = runtime.tool_router.open_session("admin-close-all-b").agent_session_id;

  await runtime.tool_router.call_tool(first_session_id, "attach_to_tab", { tab_id: 101 });
  await runtime.tool_router.call_tool(second_session_id, "attach_to_tab", { tab_id: 102 });

  const response = await bridge.emit_ui_admin_request_for_tests("close_all_sessions", {});

  expect(response.ok).toBe(true);
  const result = response.result as {
    attempted_session_ids: string[];
    closed_session_ids: string[];
    failed: Array<{ agent_session_id: string; error: string }>;
  };
  expect(result.attempted_session_ids).toContain(first_session_id);
  expect(result.attempted_session_ids).toContain(second_session_id);
  expect(result.closed_session_ids).toContain(first_session_id);
  expect(result.closed_session_ids).toContain(second_session_id);
  expect(result.failed.length).toBe(0);
  expect(runtime.session_registry.list_active_sessions().length).toBe(0);
  expect(runtime.tab_lock_manager.get_lock(101)).toBeUndefined();
  expect(runtime.tab_lock_manager.get_lock(102)).toBeUndefined();

  await runtime.stop();
});

test("ui admin detach_tab_lock releases the owner lock", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  const session_id = runtime.tool_router.open_session("admin-detach-lock").agent_session_id;
  await runtime.tool_router.call_tool(session_id, "attach_to_tab", { tab_id: 101 });

  const response = await bridge.emit_ui_admin_request_for_tests("detach_tab_lock", {
    tab_id: 101,
  });

  expect(response.ok).toBe(true);
  const result = response.result as {
    tab_id: number;
    detached: boolean;
    lock_found: boolean;
    owner_agent_session_id?: string;
  };
  expect(result.detached).toBe(true);
  expect(result.lock_found).toBe(true);
  expect(result.owner_agent_session_id).toBe(session_id);
  expect(runtime.tab_lock_manager.get_lock(101)).toBeUndefined();

  await runtime.stop();
});

test("runtime enforces loopback-only bridge host", () => {
  expect(
    () =>
      new local_mcp_runtime({
        bridge_mode: "in_memory",
        bridge_host: "0.0.0.0",
        bridge_port: test_bridge_port,
      }),
  ).toThrow();
});

test("browser_snapshot emits element_ref targets that browser_interact can reuse", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const session_id = runtime.tool_router.open_session("element-ref-agent").agent_session_id;
  await runtime.tool_router.call_tool(session_id, "attach_to_tab", { tab_id: 101 });

  const snapshot_result = await runtime.tool_router.call_tool(session_id, "browser_snapshot", {});
  const snapshot = snapshot_result.snapshot as Array<Record<string, unknown>>;
  const target = snapshot.find((node) => typeof node.element_ref === "string");
  expect(target).toBeDefined();

  const interact_result = await runtime.tool_router.call_tool(session_id, "browser_interact", {
    action: "click",
    element_ref: target?.element_ref,
  });

  const results = interact_result.results as Array<Record<string, unknown>>;
  expect(results[0]?.ok).toBe(true);
  expect(results[0]?.element_ref).toBe(target?.element_ref);

  await runtime.stop();
});

test("browser_navigate invalidates element_ref handles", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });

  const session_id = runtime.tool_router.open_session("stale-ref-agent").agent_session_id;
  await runtime.tool_router.call_tool(session_id, "attach_to_tab", { tab_id: 101 });

  const snapshot_result = await runtime.tool_router.call_tool(session_id, "browser_snapshot", {});
  const snapshot = snapshot_result.snapshot as Array<Record<string, unknown>>;
  const target = snapshot.find((node) => typeof node.element_ref === "string");
  expect(target).toBeDefined();

  await runtime.tool_router.call_tool(session_id, "browser_navigate", {
    action: "url",
    url: "https://example.net",
  });

  try {
    await runtime.tool_router.call_tool(session_id, "browser_get_element_styles", {
      element_ref: target?.element_ref,
    });
    throw new Error("expected stale element_ref error");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("STALE_ELEMENT_REFERENCE");
  }

  await runtime.stop();
});
