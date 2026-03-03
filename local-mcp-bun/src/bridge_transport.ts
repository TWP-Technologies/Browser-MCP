import { tool_error } from "./errors";
import type {
  bridge_state,
  extension_inbound,
  extension_request,
  extension_response,
  listed_tab_snapshot,
  tab_snapshot,
} from "./types";

export interface bridge_transport {
  get_state(): bridge_state;
  list_tabs(agent_session_id: string): Promise<tab_snapshot[]>;
  attach_to_tab(tab_id: number, agent_session_id: string): Promise<void>;
  detach_from_tab(tab_id: number, agent_session_id: string): Promise<void>;
  call_tool(
    tool_name: string,
    args: Record<string, unknown>,
    agent_session_id: string,
    tab_id?: number,
  ): Promise<unknown>;
  set_on_detach(handler: (tab_id: number, reason: string) => void): void;
  set_on_state_change(handler: (state: bridge_state) => void): void;
  stop(): Promise<void>;
}

interface pending_request {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout_id: Timer;
  action: extension_request["action"];
  agent_session_id: string;
}

interface ws_data {
  connected_at: string;
}

export class in_memory_bridge_transport implements bridge_transport {
  private state: bridge_state;
  private readonly tabs_by_id: Map<number, tab_snapshot>;
  private readonly request_log: extension_request[];
  private on_detach_handler?: (tab_id: number, reason: string) => void;
  private on_state_change_handler?: (state: bridge_state) => void;

  public constructor() {
    this.state = "up";
    this.tabs_by_id = new Map<number, tab_snapshot>();
    this.request_log = [];
  }

  public get_state(): bridge_state {
    return this.state;
  }

  public set_tabs_for_tests(tabs: tab_snapshot[]): void {
    this.tabs_by_id.clear();

    for (const tab of tabs) {
      this.tabs_by_id.set(tab.tab_id, { ...tab });
    }
  }

  public force_disconnect_for_tests(): void {
    this.state = "down";
    this.on_state_change_handler?.(this.state);
  }

  public force_reconnect_for_tests(): void {
    this.state = "up";
    this.on_state_change_handler?.(this.state);
  }

  public emit_detach_notice_for_tests(tab_id: number, reason: string): void {
    this.set_tab_debugger_attached_for_tests(tab_id, false);
    this.on_detach_handler?.(tab_id, reason);
  }

  public set_tab_debugger_attached_for_tests(tab_id: number, debugger_attached: boolean): void {
    const tab = this.tabs_by_id.get(tab_id);
    if (!tab) {
      return;
    }

    tab.debugger_attached = debugger_attached;
  }

  public get_request_log_for_tests(): extension_request[] {
    return this.request_log.map((entry) => ({
      ...entry,
      payload: { ...entry.payload },
    }));
  }

  public clear_request_log_for_tests(): void {
    this.request_log.length = 0;
  }

  public async list_tabs(agent_session_id: string): Promise<tab_snapshot[]> {
    this.assert_connected();
    this.record_request("list_tabs", {}, agent_session_id);
    return [...this.tabs_by_id.values()].map((tab) => ({ ...tab }));
  }

  public async attach_to_tab(tab_id: number, agent_session_id: string): Promise<void> {
    this.assert_connected();
    this.record_request("attach_to_tab", { tab_id }, agent_session_id);

    const tab = this.tabs_by_id.get(tab_id);
    if (!tab) {
      throw new tool_error("TAB_NOT_FOUND", `tab ${tab_id} not found`, false, { tab_id });
    }

    tab.debugger_attached = true;
  }

  public async detach_from_tab(tab_id: number, agent_session_id: string): Promise<void> {
    this.assert_connected();
    this.record_request("detach_from_tab", { tab_id }, agent_session_id);

    const tab = this.tabs_by_id.get(tab_id);
    if (!tab) {
      throw new tool_error("TAB_NOT_FOUND", `tab ${tab_id} not found`, false, { tab_id });
    }

    tab.debugger_attached = false;
    this.on_detach_handler?.(tab_id, "manual");
  }

  public async call_tool(
    tool_name: string,
    args: Record<string, unknown>,
    agent_session_id: string,
    tab_id?: number,
  ): Promise<unknown> {
    this.assert_connected();
    this.record_request(
      "call_tool",
      {
        tool_name,
        args,
        tab_id,
      },
      agent_session_id,
    );

    if (tool_name === "browser_tabs") {
      const action = args.action;
      if (action === "list") {
        return {
          tabs: [...this.tabs_by_id.values()].map((tab, index) => ({
            ...tab,
            index,
            active: false,
          })),
        };
      }

      if (action === "new") {
        const next_tab_id = this.next_tab_id();
        const url = typeof args.url === "string" ? args.url : "about:blank";
        const title = url;
        this.tabs_by_id.set(next_tab_id, {
          tab_id: next_tab_id,
          url,
          title,
          debugger_attached: false,
        });

        return {
          tab_id: next_tab_id,
          url,
          title,
        };
      }

      if (action === "close") {
        const explicit_tab_id = args.tab_id;
        const resolved_tab_id =
          typeof explicit_tab_id === "number"
            ? explicit_tab_id
            : typeof tab_id === "number"
              ? tab_id
              : undefined;

        if (resolved_tab_id && this.tabs_by_id.has(resolved_tab_id)) {
          this.tabs_by_id.delete(resolved_tab_id);
        }

        return { success: true };
      }
    }

    if (tool_name === "browser_navigate") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_navigate", false);
      }

      const tab = this.tabs_by_id.get(tab_id);
      if (!tab) {
        throw new tool_error("TAB_NOT_FOUND", `tab ${tab_id} not found`, false, { tab_id });
      }

      const action = args.action;
      if (action === "url") {
        const url = args.url;
        if (typeof url !== "string" || url.length === 0) {
          throw new tool_error("INVALID_ARGUMENT", "url is required for browser_navigate action=url", false, { args });
        }

        tab.url = url;
        tab.title = url;
      }

      return {
        tab_id,
        url: tab.url,
        title: tab.title,
      };
    }

    if (tool_name === "browser_snapshot") {
      return {
        tab_id,
        snapshot: [
          { tag: "body", text: "In-memory snapshot root" },
          { tag: "p", text: "Synthetic snapshot output for testing." },
        ],
      };
    }

    if (tool_name === "browser_evaluate") {
      const expression = typeof args.expression === "string" ? args.expression : "";
      return {
        tab_id,
        result: `in-memory-eval:${expression}`,
      };
    }

    if (tool_name === "browser_verify_text_visible") {
      const text = typeof args.text === "string" ? args.text : "";
      return {
        tab_id,
        visible: text.length > 0,
      };
    }

    if (tool_name === "browser_verify_element_visible") {
      const selector = typeof args.selector === "string" ? args.selector : "";
      return {
        tab_id,
        visible: selector.length > 0,
      };
    }

    if (tool_name === "browser_extract_content") {
      return {
        tab_id,
        content: "# In-memory Extracted Content\n\nSynthetic content body.",
      };
    }

    if (tool_name === "browser_lookup") {
      const text = typeof args.text === "string" ? args.text : "";
      return {
        tab_id,
        matches: text.length
          ? [
              {
                selector: "body",
                text,
              },
            ]
          : [],
      };
    }

    if (tool_name === "browser_network_requests") {
      const action = typeof args.action === "string" ? args.action : "list";
      if (action === "clear") {
        return { tab_id, cleared: true };
      }

      if (action === "details") {
        return { tab_id, request: null };
      }

      return {
        tab_id,
        total: 0,
        requests: [],
      };
    }

    if (tool_name === "browser_pdf_save") {
      return {
        tab_id,
        data_base64: "JVBERi0xLjQKJcTl8uXr",
        bytes: 16,
      };
    }

    return {
      tab_id,
      ok: true,
      tool_name,
      args,
    };
  }

  public set_on_detach(handler: (tab_id: number, reason: string) => void): void {
    this.on_detach_handler = handler;
  }

  public set_on_state_change(handler: (state: bridge_state) => void): void {
    this.on_state_change_handler = handler;
  }

  public async stop(): Promise<void> {
    this.state = "down";
    this.on_state_change_handler?.(this.state);
  }

  private assert_connected(): void {
    if (this.state !== "up") {
      throw new tool_error("EXTENSION_UNAVAILABLE", "extension bridge is not connected", true);
    }
  }

  private next_tab_id(): number {
    const tab_ids = [...this.tabs_by_id.keys()];
    if (tab_ids.length === 0) {
      return 1;
    }

    return Math.max(...tab_ids) + 1;
  }

  private record_request(
    action: extension_request["action"],
    payload: Record<string, unknown>,
    agent_session_id: string,
  ): void {
    this.request_log.push({
      type: "request",
      request_id: crypto.randomUUID(),
      action,
      payload,
      agent_session_id,
      received_at: new Date().toISOString(),
    });
  }
}

export class websocket_bridge_transport implements bridge_transport {
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private state: bridge_state;
  private server: Bun.Server<ws_data>;
  private extension_socket: ServerWebSocket<ws_data> | undefined;
  private readonly tabs_by_id: Map<number, tab_snapshot>;
  private readonly pending_requests: Map<string, pending_request>;
  private on_detach_handler?: (tab_id: number, reason: string) => void;
  private on_state_change_handler?: (state: bridge_state) => void;

  public constructor(host: string, port: number, path = "/extension") {
    this.host = host;
    this.port = port;
    this.path = path;
    this.state = "connecting";
    this.tabs_by_id = new Map<number, tab_snapshot>();
    this.pending_requests = new Map<string, pending_request>();

    this.server = Bun.serve<ws_data>({
      hostname: this.host,
      port: this.port,
      fetch: (request, server) => this.handle_fetch(request, server),
      websocket: {
        open: (socket) => this.handle_socket_open(socket),
        message: (socket, message) => this.handle_socket_message(socket, message),
        close: (socket) => this.handle_socket_close(socket),
        error: (_socket, error) => this.handle_socket_error(error),
      },
    });
  }

  public get_state(): bridge_state {
    return this.state;
  }

  public set_on_detach(handler: (tab_id: number, reason: string) => void): void {
    this.on_detach_handler = handler;
  }

  public set_on_state_change(handler: (state: bridge_state) => void): void {
    this.on_state_change_handler = handler;
  }

  public async list_tabs(agent_session_id: string): Promise<tab_snapshot[]> {
    const response = await this.send_request("list_tabs", {}, agent_session_id);
    const parsed_tabs = this.parse_tabs_response(response);
    this.overwrite_tab_cache(parsed_tabs);
    return parsed_tabs;
  }

  public async attach_to_tab(tab_id: number, agent_session_id: string): Promise<void> {
    await this.send_request("attach_to_tab", { tab_id }, agent_session_id);

    const tab = this.tabs_by_id.get(tab_id);
    if (tab) {
      tab.debugger_attached = true;
    }
  }

  public async detach_from_tab(tab_id: number, agent_session_id: string): Promise<void> {
    await this.send_request("detach_from_tab", { tab_id }, agent_session_id);

    const tab = this.tabs_by_id.get(tab_id);
    if (tab) {
      tab.debugger_attached = false;
    }
  }

  public async call_tool(
    tool_name: string,
    args: Record<string, unknown>,
    agent_session_id: string,
    tab_id?: number,
  ): Promise<unknown> {
    return await this.send_request("call_tool", {
      tool_name,
      args,
      tab_id,
    }, agent_session_id);
  }

  public async stop(): Promise<void> {
    for (const pending of this.pending_requests.values()) {
      clearTimeout(pending.timeout_id);
      pending.reject(new tool_error("EXTENSION_UNAVAILABLE", "bridge is stopping", true));
    }

    this.pending_requests.clear();
    this.server.stop(true);
    this.set_state("down");
  }

  public force_extension_disconnect_for_tests(code = 1012, reason = "test_disconnect"): void {
    this.extension_socket?.close(code, reason);
  }

  private handle_fetch(request: Request, server: Bun.Server<ws_data>): Response {
    const request_url = new URL(request.url);

    if (request_url.pathname !== this.path) {
      return new Response("not found", { status: 404 });
    }

    const upgraded = server.upgrade(request, {
      data: {
        connected_at: new Date().toISOString(),
      },
    });

    if (upgraded) {
      return new Response(null, { status: 101 });
    }

    return new Response("upgrade failed", { status: 500 });
  }

  private handle_socket_open(socket: ServerWebSocket<ws_data>): void {
    if (this.extension_socket) {
      this.extension_socket.close(1013, "single extension connection required");
    }

    this.extension_socket = socket;
    this.set_state("up");
  }

  private handle_socket_message(_socket: ServerWebSocket<ws_data>, raw_message: string | Buffer | Uint8Array): void {
    const text = raw_message.toString();

    let parsed: extension_inbound;
    try {
      parsed = JSON.parse(text) as extension_inbound;
    } catch {
      return;
    }

    if ("type" in parsed && parsed.type === "tabs_update") {
      this.overwrite_tab_cache(parsed.tabs);
      return;
    }

    if ("type" in parsed && parsed.type === "detach_notice") {
      const tab = this.tabs_by_id.get(parsed.tab_id);
      if (tab) {
        tab.debugger_attached = false;
      }

      this.on_detach_handler?.(parsed.tab_id, parsed.reason);
      return;
    }

    if ("request_id" in parsed && "ok" in parsed) {
      this.resolve_pending_response(parsed);
      return;
    }

    if ("type" in parsed && parsed.type === "register") {
      this.set_state("up");
    }
  }

  private handle_socket_close(_socket: ServerWebSocket<ws_data>): void {
    this.extension_socket = undefined;
    this.set_state("reconnecting");

    for (const pending of this.pending_requests.values()) {
      clearTimeout(pending.timeout_id);
      pending.reject(new tool_error("EXTENSION_UNAVAILABLE", "extension disconnected", true));
    }

    this.pending_requests.clear();
  }

  private handle_socket_error(_error: Error): void {
    this.set_state("down");
  }

  private overwrite_tab_cache(tabs: tab_snapshot[]): void {
    this.tabs_by_id.clear();

    for (const tab of tabs) {
      this.tabs_by_id.set(tab.tab_id, { ...tab });
    }
  }

  private parse_tabs_response(response: unknown): tab_snapshot[] {
    if (!response || typeof response !== "object" || !("tabs" in response)) {
      return [];
    }

    const payload_tabs = (response as { tabs: unknown }).tabs;
    if (!Array.isArray(payload_tabs)) {
      return [];
    }

    const parsed_tabs: tab_snapshot[] = [];

    for (const row of payload_tabs) {
      if (!row || typeof row !== "object") {
        continue;
      }

      const casted_row = row as Record<string, unknown>;
      const tab_id = casted_row.tab_id;
      const url = casted_row.url;
      const title = casted_row.title;
      const debugger_attached = casted_row.debugger_attached;

      if (
        typeof tab_id !== "number" ||
        typeof url !== "string" ||
        typeof title !== "string" ||
        typeof debugger_attached !== "boolean"
      ) {
        continue;
      }

      parsed_tabs.push({ tab_id, url, title, debugger_attached });
    }

    return parsed_tabs;
  }

  private resolve_pending_response(response: extension_response): void {
    const pending = this.pending_requests.get(response.request_id);
    if (!pending) {
      return;
    }

    this.pending_requests.delete(response.request_id);
    clearTimeout(pending.timeout_id);

    if (typeof response.agent_session_id !== "string") {
      pending.reject(new tool_error("INVALID_ARGUMENT", "extension response missing agent_session_id", false));
      return;
    }

    if (response.agent_session_id !== pending.agent_session_id) {
      pending.reject(
        new tool_error("INVALID_ARGUMENT", "extension response agent_session_id mismatch", false, {
          request_id: response.request_id,
          expected_agent_session_id: pending.agent_session_id,
          received_agent_session_id: response.agent_session_id,
        }),
      );
      return;
    }

    if (!response.ok) {
      const error_code = pending.action === "detach_from_tab" ? "DETACH_FAILED" : "ATTACH_FAILED";
      pending.reject(new tool_error(error_code, response.error ?? "extension request failed", false));
      return;
    }

    pending.resolve(response.result);
  }

  private async send_request(
    action: extension_request["action"],
    payload: Record<string, unknown>,
    agent_session_id: string,
  ): Promise<unknown> {
    if (!this.extension_socket || this.state !== "up") {
      throw new tool_error("EXTENSION_UNAVAILABLE", "extension bridge is not connected", true);
    }

    const request_id = crypto.randomUUID();

    return await new Promise<unknown>((resolve, reject) => {
      const timeout_id = setTimeout(() => {
        this.pending_requests.delete(request_id);
        reject(new tool_error("TIMEOUT", `extension request timed out: ${action}`, true));
      }, 30_000);

      this.pending_requests.set(request_id, {
        resolve,
        reject,
        timeout_id,
        action,
        agent_session_id,
      });

      const request_payload: extension_request = {
        type: "request",
        request_id,
        agent_session_id,
        received_at: new Date().toISOString(),
        action,
        payload,
      };

      this.extension_socket?.send(JSON.stringify(request_payload));
    });
  }

  private set_state(next_state: bridge_state): void {
    if (this.state === next_state) {
      return;
    }

    this.state = next_state;
    this.on_state_change_handler?.(next_state);
  }
}

export function merge_tabs_with_locks(tabs: tab_snapshot[], locks: Map<number, string>): listed_tab_snapshot[] {
  return tabs.map((tab) => {
    const lock_owner = locks.get(tab.tab_id);
    if (!lock_owner) {
      return {
        ...tab,
        is_locked_by_agent: false,
      };
    }

    return {
      ...tab,
      is_locked_by_agent: true,
      locked_by_agent_session_id: lock_owner,
    };
  });
}
