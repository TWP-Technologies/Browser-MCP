import { expect, test } from "bun:test";
import { mcp_protocol_session } from "../../src/mcp_protocol_session";
import { local_mcp_runtime } from "../../src/runtime";
import type { json_rpc_response } from "../../src/types";

function build_initialize_request(id: string, client_name: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: client_name,
        version: "0.0.1",
      },
    },
  });
}

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

test("mcp_protocol_session clears the old binding before reinitialize awaits session close", async () => {
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

  const original_close_session = runtime.tool_router.close_session.bind(runtime.tool_router);

  try {
    await protocol_session.handle_line(build_initialize_request("init-1", "first-client"));

    const first_agent_session_id = runtime.session_registry.list_active_sessions()[0];
    if (typeof first_agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    let released_before_close_await = false;
    runtime.tool_router.close_session = async (agent_session_id) => {
      if (agent_session_id === first_agent_session_id) {
        released_before_close_await = released_session_ids.includes(first_agent_session_id);
        await new Promise((resolve_promise) => {
          setTimeout(resolve_promise, 20);
        });
      }

      return await original_close_session(agent_session_id);
    };

    await protocol_session.handle_line(build_initialize_request("init-2", "second-client"));

    const second_initialize_response = responses.find((response) => response.id === "init-2");
    const second_agent_session_id = (second_initialize_response?.result as { agent_session_id?: string } | undefined)
      ?.agent_session_id;

    expect(released_before_close_await).toBe(true);
    expect(typeof second_agent_session_id).toBe("string");
    expect(second_agent_session_id).not.toBe(first_agent_session_id);
    expect(runtime.session_registry.list_active_sessions()).toEqual([second_agent_session_id]);
  } finally {
    runtime.tool_router.close_session = original_close_session;
    await runtime.stop();
  }
});

test("mcp_protocol_session clears stale implicit session ids for tools/call and session/close", async () => {
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
    await protocol_session.handle_line(build_initialize_request("init", "implicit-session-test"));

    const agent_session_id = runtime.session_registry.list_active_sessions()[0];
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    await runtime.tool_router.close_session(agent_session_id);
    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "call",
        method: "tools/call",
        params: {
          name: "list_available_tabs",
          arguments: {},
        },
      }),
    );
    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "close",
        method: "session/close",
        params: {},
      }),
    );

    const call_response = responses.find((response) => response.id === "call");
    const call_result = call_response?.result as
      | {
          isError?: boolean;
          structuredContent?: {
            code?: string;
          };
        }
      | undefined;
    const close_response = responses.find((response) => response.id === "close");

    expect(call_result?.isError).toBe(true);
    expect(call_result?.structuredContent?.code).toBe("INVALID_ARGUMENT");
    expect(close_response?.error?.message).toContain("session/close requires agent_session_id");
    expect(released_session_ids).toEqual([agent_session_id]);
  } finally {
    await runtime.stop();
  }
});

test("mcp_protocol_session returns SESSION_NOT_FOUND for explicit legacy session ids", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const responses: json_rpc_response[] = [];
  const protocol_session = new mcp_protocol_session({
    runtime,
    write_response: (response) => {
      responses.push(response);
    },
  });

  try {
    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "legacy-call",
        method: "tools/call",
        params: {
          agent_session_id: "missing-session",
          name: "list_available_tabs",
          arguments: {},
        },
      }),
    );

    const call_response = responses.find((response) => response.id === "legacy-call");
    const call_result = call_response?.result as
      | {
          isError?: boolean;
          structuredContent?: {
            code?: string;
            message?: string;
          };
        }
      | undefined;

    expect(call_result?.isError).toBe(true);
    expect(call_result?.structuredContent?.code).toBe("SESSION_NOT_FOUND");
    expect(call_result?.structuredContent?.message).toContain("missing-session");
  } finally {
    await runtime.stop();
  }
});

test("mcp_protocol_session clears stale bound state when an explicit agent_session_id is reused", async () => {
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
    await protocol_session.handle_line(build_initialize_request("init", "explicit-stale-bound-id"));

    const agent_session_id = runtime.session_registry.list_active_sessions()[0];
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    await runtime.tool_router.close_session(agent_session_id);
    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "explicit-call",
        method: "tools/call",
        params: {
          agent_session_id,
          name: "list_available_tabs",
          arguments: {},
        },
      }),
    );

    const call_response = responses.find((response) => response.id === "explicit-call");
    const call_result = call_response?.result as
      | {
          isError?: boolean;
          structuredContent?: {
            code?: string;
            message?: string;
          };
        }
      | undefined;

    expect(call_result?.isError).toBe(true);
    expect(call_result?.structuredContent?.code).toBe("SESSION_NOT_FOUND");
    expect(call_result?.structuredContent?.message).toContain(agent_session_id);
    expect(released_session_ids).toEqual([agent_session_id]);
  } finally {
    await runtime.stop();
  }
});

test("mcp_protocol_session ignores lifecycle callback failures", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const responses: json_rpc_response[] = [];
  const protocol_session = new mcp_protocol_session({
    runtime,
    write_response: (response) => {
      responses.push(response);
    },
    on_agent_session_bound: () => {
      throw new Error("bind failed");
    },
    on_agent_session_released: () => {
      throw new Error("release failed");
    },
  });

  const original_console_error = console.error;
  const logged_errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged_errors.push(args);
  };

  try {
    await protocol_session.handle_line(build_initialize_request("init", "callback-failure-test"));

    const agent_session_id = runtime.session_registry.list_active_sessions()[0];
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    await protocol_session.close();

    const initialize_response = responses.find((response) => response.id === "init");
    const initialize_result = initialize_response?.result as { agent_session_id?: string } | undefined;

    expect(initialize_result?.agent_session_id).toBe(agent_session_id);
    expect(runtime.session_registry.list_active_sessions()).toEqual([]);
    expect(logged_errors).toHaveLength(2);
  } finally {
    console.error = original_console_error;
    await runtime.stop();
  }
});
