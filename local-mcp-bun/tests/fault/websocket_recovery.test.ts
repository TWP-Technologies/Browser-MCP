import { expect, test } from "bun:test";
import { websocket_bridge_transport } from "../../src/bridge_transport";
import { tool_error } from "../../src/errors";
import type { extension_request, tab_snapshot } from "../../src/types";

interface fake_extension_options {
  respond_to_call_tool: boolean;
  tabs: tab_snapshot[];
}

interface fake_extension_handle {
  socket: WebSocket;
  requests: extension_request[];
}

async function sleep(timeout_ms: number): Promise<void> {
  await new Promise((resolve_promise) => {
    setTimeout(resolve_promise, timeout_ms);
  });
}

async function wait_for_condition(
  predicate: () => boolean | Promise<boolean>,
  timeout_ms = 5_000,
  interval_ms = 25,
): Promise<void> {
  const started_at = Date.now();
  while (Date.now() - started_at < timeout_ms) {
    if (await predicate()) {
      return;
    }

    await sleep(interval_ms);
  }

  throw new Error(`timed out waiting for condition after ${timeout_ms}ms`);
}

function send_ok_response(socket: WebSocket, request: extension_request, result: Record<string, unknown>): void {
  socket.send(
    JSON.stringify({
      request_id: request.request_id,
      agent_session_id: request.agent_session_id,
      ok: true,
      result,
    }),
  );
}

function random_port(): number {
  return 39_000 + Math.floor(Math.random() * 1_000);
}

async function connect_fake_extension(port: number, options: fake_extension_options): Promise<fake_extension_handle> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  const requests: extension_request[] = [];

  socket.addEventListener("message", (event) => {
    let payload: unknown;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (!payload || typeof payload !== "object") {
      return;
    }

    if (!("type" in payload) || (payload as { type?: string }).type !== "request") {
      return;
    }

    const request = payload as extension_request;
    requests.push(request);

    if (request.action === "list_tabs") {
      send_ok_response(socket, request, { tabs: options.tabs });
      return;
    }

    if (request.action === "attach_to_tab") {
      send_ok_response(socket, request, { attached: true, tab_id: request.payload.tab_id });
      return;
    }

    if (request.action === "detach_from_tab") {
      send_ok_response(socket, request, { detached: true, tab_id: request.payload.tab_id });
      return;
    }

    if (request.action === "call_tool" && options.respond_to_call_tool) {
      send_ok_response(socket, request, {
        ok: true,
        tool_name: request.payload.tool_name,
      });
    }
  });

  await new Promise<void>((resolve_promise, reject_promise) => {
    const timeout_id = setTimeout(() => {
      reject_promise(new Error("timed out waiting for fake extension open"));
    }, 5_000);

    socket.addEventListener("open", () => {
      clearTimeout(timeout_id);
      socket.send(
        JSON.stringify({
          type: "register",
          extension_id: "fake-extension",
        }),
      );
      resolve_promise();
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout_id);
      reject_promise(new Error("fake extension websocket error"));
    });
  });

  return { socket, requests };
}

test("websocket bridge rejects in-flight requests on disconnect and recovers after reconnect", async () => {
  const port = random_port();
  const bridge = new websocket_bridge_transport("127.0.0.1", port);

  const first_extension = await connect_fake_extension(port, {
    respond_to_call_tool: false,
    tabs: [
      {
        tab_id: 101,
        url: "https://example.com",
        title: "Example",
        debugger_attached: true,
      },
    ],
  });

  await wait_for_condition(() => bridge.get_state() === "up");

  const in_flight_call = bridge.call_tool(
    "browser_interact",
    {
      actions: [{ type: "wait", timeout: 5000 }],
    },
    "agent-a",
    101,
  );

  await wait_for_condition(() =>
    first_extension.requests.some((request) => request.action === "call_tool"),
  );

  first_extension.socket.close(1012, "restart");

  try {
    await in_flight_call;
    throw new Error("expected in-flight request to fail after disconnect");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("EXTENSION_UNAVAILABLE");
  }

  const second_extension = await connect_fake_extension(port, {
    respond_to_call_tool: true,
    tabs: [
      {
        tab_id: 101,
        url: "https://example.com",
        title: "Example",
        debugger_attached: true,
      },
    ],
  });

  await wait_for_condition(() => bridge.get_state() === "up");

  const tabs = await bridge.list_tabs("agent-a");
  expect(tabs.length).toBe(1);
  expect(tabs[0]?.tab_id).toBe(101);

  second_extension.socket.close(1000, "test complete");
  await bridge.stop();
});
