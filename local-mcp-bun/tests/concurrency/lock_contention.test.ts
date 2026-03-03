import { expect, test } from "bun:test";
import { local_mcp_runtime } from "../../src/runtime";
import { in_memory_bridge_transport } from "../../src/bridge_transport";
import { tool_error } from "../../src/errors";

function seeded_random(seed: number): () => number {
  let state = seed >>> 0;

  function next(): number {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  }

  return next;
}

test("supports 8 concurrent sessions with no lock corruption", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  bridge.set_tabs_for_tests([
    { tab_id: 201, url: "https://one.test", title: "One", debugger_attached: false },
    { tab_id: 202, url: "https://two.test", title: "Two", debugger_attached: false },
    { tab_id: 203, url: "https://three.test", title: "Three", debugger_attached: false },
    { tab_id: 204, url: "https://four.test", title: "Four", debugger_attached: false },
  ]);

  const sessions = Array.from({ length: 8 }, (_unused, index) => runtime.tool_router.open_session(`agent-${index}`).agent_session_id);
  const random = seeded_random(42);

  const workers = sessions.map(async (session_id) => {
    for (let i = 0; i < 100; i += 1) {
      const tab_id = 201 + Math.floor(random() * 4);

      try {
        await runtime.tool_router.call_tool(session_id, "attach_to_tab", {
          tab_id,
          wait_timeout_ms: 10,
        });
      } catch (error) {
        if (!(error instanceof tool_error) || !["LOCK_CONFLICT", "TIMEOUT"].includes(error.code)) {
          throw error;
        }
      }

      try {
        await runtime.tool_router.call_tool(session_id, "detach_from_tab", { tab_id });
      } catch (error) {
        if (!(error instanceof tool_error) || error.code !== "LOCK_NOT_OWNED") {
          throw error;
        }
      }
    }
  });

  await Promise.all(workers);

  for (const lock of runtime.tab_lock_manager.list_locks()) {
    expect(lock.owner_agent_session_id.length).toBeGreaterThan(0);
  }

  for (const session_id of sessions) {
    await runtime.tool_router.close_session(session_id);
  }

  expect(runtime.tab_lock_manager.list_locks()).toEqual([]);
  await runtime.stop();
});
