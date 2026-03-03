import { expect, test } from "bun:test";
import { local_mcp_runtime } from "../../src/runtime";
import { in_memory_bridge_transport } from "../../src/bridge_transport";
import { tool_error } from "../../src/errors";

async function wait_for_condition(predicate: () => boolean, timeout_ms = 1500): Promise<void> {
  const started_at = Date.now();

  while (Date.now() - started_at < timeout_ms) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`timed out waiting for condition after ${timeout_ms}ms`);
}

test("closing a session releases owned locks", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const session_id = runtime.tool_router.open_session("owner").agent_session_id;
  await runtime.tool_router.call_tool(session_id, "attach_to_tab", { tab_id: 101 });

  const close_result = await runtime.tool_router.close_session(session_id);
  expect(close_result.released_tab_ids).toEqual([101]);
  expect(runtime.tab_lock_manager.get_lock(101)).toBeUndefined();

  await runtime.stop();
});

test("bridge disconnect produces EXTENSION_UNAVAILABLE", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  bridge.force_disconnect_for_tests();

  const session_id = runtime.tool_router.open_session("owner").agent_session_id;

  try {
    await runtime.tool_router.call_tool(session_id, "list_available_tabs", {});
    throw new Error("expected extension unavailable");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("EXTENSION_UNAVAILABLE");
  }

  await runtime.stop();
});

test("reconciles stale locks after bridge reconnect", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  const owner_session_id = runtime.tool_router.open_session("owner").agent_session_id;
  const contender_session_id = runtime.tool_router.open_session("contender").agent_session_id;

  await runtime.tool_router.call_tool(owner_session_id, "attach_to_tab", { tab_id: 101 });
  expect(runtime.tab_lock_manager.get_lock(101)?.owner_agent_session_id).toBe(owner_session_id);

  bridge.force_disconnect_for_tests();
  bridge.set_tab_debugger_attached_for_tests(101, false);
  bridge.force_reconnect_for_tests();
  await wait_for_condition(() => runtime.tab_lock_manager.get_lock(101) === undefined);

  expect(runtime.tab_lock_manager.get_lock(101)).toBeUndefined();

  const attach_result = await runtime.tool_router.call_tool(contender_session_id, "attach_to_tab", {
    tab_id: 101,
  });
  expect(attach_result.owner_agent_session_id).toBe(contender_session_id);

  await runtime.stop();
});

test("detach notice releases lock ownership for a closed target", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  const owner_session_id = runtime.tool_router.open_session("owner").agent_session_id;
  const contender_session_id = runtime.tool_router.open_session("contender").agent_session_id;

  await runtime.tool_router.call_tool(owner_session_id, "attach_to_tab", { tab_id: 101 });
  expect(runtime.tab_lock_manager.get_lock(101)?.owner_agent_session_id).toBe(owner_session_id);

  bridge.emit_detach_notice_for_tests(101, "target_closed");
  await wait_for_condition(() => runtime.tab_lock_manager.get_lock(101) === undefined);

  const attach_result = await runtime.tool_router.call_tool(contender_session_id, "attach_to_tab", {
    tab_id: 101,
  });
  expect(attach_result.owner_agent_session_id).toBe(contender_session_id);

  await runtime.stop();
});

test("runtime stop reclaims locks for unclosed sessions", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const owner_session_id = runtime.tool_router.open_session("owner").agent_session_id;
  await runtime.tool_router.call_tool(owner_session_id, "attach_to_tab", { tab_id: 101 });
  expect(runtime.tab_lock_manager.get_lock(101)?.owner_agent_session_id).toBe(owner_session_id);
  expect(runtime.session_registry.list_active_sessions().includes(owner_session_id)).toBe(true);

  await runtime.stop();

  expect(runtime.tab_lock_manager.get_lock(101)).toBeUndefined();
  expect(runtime.session_registry.list_active_sessions().includes(owner_session_id)).toBe(false);
});
