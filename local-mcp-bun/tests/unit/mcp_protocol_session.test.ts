import { expect, test } from "bun:test";
import { mcp_protocol_session } from "../../src/mcp_protocol_session";
import { local_mcp_runtime } from "../../src/runtime";
import type { json_rpc_response } from "../../src/types";

function build_initialize_request(id: string, client_name: string, token?: string): string {
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
      token,
    },
  });
}

test("mcp_protocol_session rebinds stale initialized-session notifications after external close", async () => {
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

    const active_sessions = runtime.session_registry.list_active_sessions();
    expect(active_sessions).toHaveLength(1);
    expect(active_sessions[0]).not.toBe(agent_session_id);
    expect(released_session_ids).toEqual([agent_session_id]);
    expect(responses).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("mcp_protocol_session does not throw when notification rebind fails", async () => {
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

  const original_open_session = runtime.tool_router.open_session.bind(runtime.tool_router);
  const original_console_error = console.error;
  const logged_errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged_errors.push(args);
  };

  try {
    await protocol_session.handle_line(build_initialize_request("init", "notification-rebind-failure"));

    const agent_session_id = runtime.session_registry.list_active_sessions()[0];
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    await runtime.tool_router.close_session(agent_session_id);
    runtime.tool_router.open_session = () => {
      throw new Error("token rotated");
    };

    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {},
      }),
    );

    expect(responses).toHaveLength(1);
    expect(runtime.session_registry.list_active_sessions()).toEqual([]);
    expect(logged_errors).toHaveLength(1);
    expect(String(logged_errors[0]?.[0])).toContain("failed to refresh MCP notification session");
  } finally {
    runtime.tool_router.open_session = original_open_session;
    console.error = original_console_error;
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
    if (typeof second_agent_session_id !== "string") {
      throw new Error("expected second initialized session");
    }

    expect(released_before_close_await).toBe(true);
    expect(second_agent_session_id).not.toBe(first_agent_session_id);
    expect(runtime.session_registry.list_active_sessions()).toEqual([second_agent_session_id]);
  } finally {
    runtime.tool_router.close_session = original_close_session;
    await runtime.stop();
  }
});

test("mcp_protocol_session rebinds stale implicit session ids for tools/call and session/close", async () => {
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
            tabs?: unknown[];
          };
        }
      | undefined;
    const close_response = responses.find((response) => response.id === "close");
    const close_result = close_response?.result as
      | {
          released_tab_ids?: number[];
          cancelled_waiting_tab_ids?: number[];
        }
      | undefined;

    expect(call_result?.isError).not.toBe(true);
    expect(Array.isArray(call_result?.structuredContent?.tabs)).toBe(true);
    expect(close_response?.error).toBeUndefined();
    expect(close_result?.released_tab_ids).toEqual([]);
    expect(released_session_ids).toHaveLength(2);
    expect(released_session_ids[0]).toBe(agent_session_id);
    expect(released_session_ids[1]).not.toBe(agent_session_id);
  } finally {
    await runtime.stop();
  }
});

test("mcp_protocol_session revalidates the initialize token when rebinding implicit sessions", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
    auth_token: "secret-token",
  });

  const supplied_tokens: Array<string | undefined> = [];
  const responses: json_rpc_response[] = [];
  const original_open_session = runtime.tool_router.open_session.bind(runtime.tool_router);
  runtime.tool_router.open_session = (client_name, supplied_token) => {
    supplied_tokens.push(supplied_token);
    return original_open_session(client_name, supplied_token);
  };
  const protocol_session = new mcp_protocol_session({
    runtime,
    write_response: (response) => {
      responses.push(response);
    },
  });

  try {
    await protocol_session.handle_line(build_initialize_request("init", "token-rebind-test", "secret-token"));

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

    const call_response = responses.find((response) => response.id === "call");
    expect(call_response?.error).toBeUndefined();
    expect(supplied_tokens).toEqual(["secret-token", "secret-token"]);
    expect(runtime.session_registry.list_active_sessions()[0]).not.toBe(agent_session_id);
  } finally {
    runtime.tool_router.open_session = original_open_session;
    await runtime.stop();
  }
});

test("mcp_protocol_session clears cached auth state after request rebind fails", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  const responses: json_rpc_response[] = [];
  const original_open_session = runtime.tool_router.open_session.bind(runtime.tool_router);
  const protocol_session = new mcp_protocol_session({
    runtime,
    write_response: (response) => {
      responses.push(response);
    },
  });

  try {
    await protocol_session.handle_line(build_initialize_request("init", "request-rebind-failure"));

    const agent_session_id = runtime.session_registry.list_active_sessions()[0];
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    await runtime.tool_router.close_session(agent_session_id);
    runtime.tool_router.open_session = () => {
      throw new Error("token rotated");
    };

    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "failed-rebind",
        method: "tools/call",
        params: {
          name: "list_available_tabs",
          arguments: {},
        },
      }),
    );

    runtime.tool_router.open_session = original_open_session;
    await protocol_session.handle_line(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "after-clear",
        method: "tools/call",
        params: {
          name: "list_available_tabs",
          arguments: {},
        },
      }),
    );

    const failed_rebind_response = responses.find((response) => response.id === "failed-rebind");
    const after_clear_response = responses.find((response) => response.id === "after-clear");
    const after_clear_result = after_clear_response?.result as
      | {
          isError?: boolean;
          structuredContent?: {
            code?: string;
          };
        }
      | undefined;

    expect(failed_rebind_response?.error?.message).toBe("token rotated");
    expect(after_clear_result?.isError).toBe(true);
    expect(after_clear_result?.structuredContent?.code).toBe("INVALID_ARGUMENT");
    expect(runtime.session_registry.list_active_sessions()).toEqual([]);
  } finally {
    runtime.tool_router.open_session = original_open_session;
    await runtime.stop();
  }
});

test("mcp_protocol_session drops cached auth state when reinitialize fails", async () => {
  const runtime = new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
    auth_token: "secret-token",
  });

  const responses: json_rpc_response[] = [];
  const protocol_session = new mcp_protocol_session({
    runtime,
    write_response: (response) => {
      responses.push(response);
    },
  });

  try {
    await protocol_session.handle_line(build_initialize_request("init-1", "failed-reinit-test", "secret-token"));

    const agent_session_id = runtime.session_registry.list_active_sessions()[0];
    if (typeof agent_session_id !== "string") {
      throw new Error("expected initialized session");
    }

    await protocol_session.handle_line(build_initialize_request("init-2", "failed-reinit-test", "wrong-token"));
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

    const failed_initialize_response = responses.find((response) => response.id === "init-2");
    const call_response = responses.find((response) => response.id === "call");
    const call_result = call_response?.result as
      | {
          isError?: boolean;
          structuredContent?: {
            code?: string;
          };
        }
      | undefined;

    expect(failed_initialize_response?.error?.message).toContain("invalid token");
    expect(call_result?.isError).toBe(true);
    expect(call_result?.structuredContent?.code).toBe("INVALID_ARGUMENT");
    expect(runtime.session_registry.list_active_sessions()).toEqual([]);
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
