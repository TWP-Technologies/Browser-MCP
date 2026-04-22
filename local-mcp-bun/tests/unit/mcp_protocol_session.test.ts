import { expect, test } from "bun:test";
import { mcp_protocol_session } from "../../src/mcp_protocol_session";
import { local_mcp_runtime } from "../../src/runtime";
import type { json_rpc_response } from "../../src/types";

test("mcp_protocol_session ignores stale initialized-session notifications after external close", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const released_session_ids: string[] = [];
  const responses: json_rpc_response[] = [];
  const protocol_session = new mcp_protocol_session({
    runtime,
    write_response: (response) => {
      responses.push(response);
    },
    on_agent_session_released: (agent_session_id) => {
      released_session_ids.push(agent_session_id);
    },
  });

  try {
    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "stale-notification-test",
            version: "0.0.1",
          },
        },
      }),
    );

    const agent_session_id = runtime.session_registry.list_active_sessions()[0];
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    await runtime.tool_router.close_session(agent_session_id);
    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {},
      }),
    );

    expect(runtime.session_registry.list_active_sessions()).toEqual([]);
    expect(released_session_ids).toEqual([agent_session_id]);
    expect(responses).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});
