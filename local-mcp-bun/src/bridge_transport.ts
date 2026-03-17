import { tool_error } from "./errors";
import type {
  bridge_state,
  connections_snapshot,
  extension_inbound,
  extension_request,
  extension_response,
  listed_tab_snapshot,
  ui_admin_request,
  ui_admin_response,
  tab_snapshot,
} from "./types";

interface ui_admin_request_result {
  ok: boolean;
  result?: unknown;
  error?: string;
}

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
  set_on_ui_admin_request(
    handler: (
      request_id: string,
      action: ui_admin_request["action"],
      payload: Record<string, unknown>,
    ) => Promise<ui_admin_request_result>,
  ): void;
  publish_connections_snapshot(snapshot: connections_snapshot): Promise<void>;
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
  private readonly element_refs_by_tab: Map<number, Map<string, string>>;
  private readonly element_ref_revision_by_tab: Map<number, number>;
  private on_detach_handler?: (tab_id: number, reason: string) => void;
  private on_state_change_handler?: (state: bridge_state) => void;
  private on_ui_admin_request_handler?: (
    request_id: string,
    action: ui_admin_request["action"],
    payload: Record<string, unknown>,
  ) => Promise<ui_admin_request_result>;
  private last_connections_snapshot: connections_snapshot | null;

  public constructor() {
    this.state = "up";
    this.tabs_by_id = new Map<number, tab_snapshot>();
    this.request_log = [];
    this.element_refs_by_tab = new Map<number, Map<string, string>>();
    this.element_ref_revision_by_tab = new Map<number, number>();
    this.last_connections_snapshot = null;
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

  public get_last_connections_snapshot_for_tests(): connections_snapshot | null {
    if (!this.last_connections_snapshot) {
      return null;
    }

    return JSON.parse(JSON.stringify(this.last_connections_snapshot)) as connections_snapshot;
  }

  private require_tab(tab_id: number, tool_name: string): tab_snapshot {
    const tab = this.tabs_by_id.get(tab_id);
    if (!tab) {
      throw new tool_error("TAB_NOT_FOUND", `${tool_name}: tab ${tab_id} not found`, false, {
        tab_id,
      });
    }

    return tab;
  }

  public async emit_ui_admin_request_for_tests(
    action: ui_admin_request["action"],
    payload: Record<string, unknown>,
  ): Promise<ui_admin_response> {
    const request_id = crypto.randomUUID();
    if (!this.on_ui_admin_request_handler) {
      return {
        type: "ui_admin_response",
        request_id,
        ok: false,
        error: "ui admin handler unavailable",
      };
    }

    try {
      const result = await this.on_ui_admin_request_handler(request_id, action, payload);
      return {
        type: "ui_admin_response",
        request_id,
        ok: result.ok,
        result: result.result,
        error: result.error,
      };
    } catch (error) {
      return {
        type: "ui_admin_response",
        request_id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
    this.reset_element_refs_for_tab(tab_id);
  }

  public async detach_from_tab(tab_id: number, agent_session_id: string): Promise<void> {
    this.assert_connected();
    this.record_request("detach_from_tab", { tab_id }, agent_session_id);

    const tab = this.tabs_by_id.get(tab_id);
    if (!tab) {
      throw new tool_error("TAB_NOT_FOUND", `tab ${tab_id} not found`, false, { tab_id });
    }

    tab.debugger_attached = false;
    this.reset_element_refs_for_tab(tab_id);
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
            active: tab.active === true,
            stealth: tab.stealth === true,
          })),
        };
      }

      if (action === "new") {
        const next_tab_id = this.next_tab_id();
        const url = typeof args.url === "string" ? args.url : "about:blank";
        const title = url;
        const activate = args.activate !== false;
        const stealth = args.stealth === true;
        for (const tab of this.tabs_by_id.values()) {
          tab.active = false;
        }
        this.tabs_by_id.set(next_tab_id, {
          tab_id: next_tab_id,
          url,
          title,
          debugger_attached: false,
          active: activate,
          stealth,
        });

        return {
          tab_id: next_tab_id,
          url,
          title,
          active: activate,
          stealth,
        };
      }

      if (action === "activate") {
        const explicit_tab_id = args.tab_id;
        if (typeof explicit_tab_id !== "number") {
          throw new tool_error("INVALID_ARGUMENT", "browser_tabs activate requires tab_id", false, { args });
        }

        const tab = this.tabs_by_id.get(explicit_tab_id);
        if (!tab) {
          throw new tool_error("TAB_NOT_FOUND", `tab ${explicit_tab_id} not found`, false, { tab_id: explicit_tab_id });
        }

        for (const entry of this.tabs_by_id.values()) {
          entry.active = false;
        }
        tab.active = true;

        return {
          tab_id: explicit_tab_id,
          active: true,
        };
      }

      if (action === "set_stealth") {
        const explicit_tab_id = args.tab_id;
        if (typeof explicit_tab_id !== "number") {
          throw new tool_error("INVALID_ARGUMENT", "browser_tabs set_stealth requires tab_id", false, { args });
        }

        const tab = this.tabs_by_id.get(explicit_tab_id);
        if (!tab) {
          throw new tool_error("TAB_NOT_FOUND", `tab ${explicit_tab_id} not found`, false, { tab_id: explicit_tab_id });
        }

        tab.stealth = args.stealth === true;
        return {
          tab_id: explicit_tab_id,
          stealth: tab.stealth,
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

        return { success: true, closed: true, tab_id: resolved_tab_id };
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
      } else if (action === "test_page") {
        tab.url = "data:text/html,<html><body><h1>Local MCP Bun Test Page</h1></body></html>";
        tab.title = "Local MCP Bun Test Page";
      }

      this.reset_element_refs_for_tab(tab_id);

      return {
        tab_id,
        url: tab.url,
        title: tab.title,
        action,
      };
    }

    if (tool_name === "browser_snapshot") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_snapshot", false);
      }

      const tab = this.require_tab(tab_id, "browser_snapshot");
      this.reset_element_refs_for_tab(tab_id);
      const body_ref = this.register_element_ref(tab_id, "body");
      const button_ref = this.register_element_ref(tab_id, "button.primary-action");

      return {
        tab_id,
        url: tab.url,
        title: tab.title,
        snapshot: [
          {
            tag: "body",
            role: "document",
            name: "Synthetic document",
            text: "In-memory snapshot root",
            selector: "body",
            element_ref: body_ref,
            visible: true,
          },
          {
            tag: "button",
            role: "button",
            name: "Primary action",
            text: "Continue",
            selector: "button.primary-action",
            element_ref: button_ref,
            visible: true,
          },
        ],
        total_nodes: 2,
        truncated: false,
      };
    }

    if (tool_name === "browser_evaluate") {
      const expression =
        typeof args.expression === "string"
          ? args.expression
          : typeof args.function === "string"
            ? `(${args.function})()`
            : "";
      return {
        tab_id,
        ok: true,
        value: `in-memory-eval:${expression}`,
        value_type: "string",
      };
    }

    if (tool_name === "browser_verify_text_visible") {
      const text = typeof args.text === "string" ? args.text : "";
      return {
        tab_id,
        text,
        visible: text.length > 0,
      };
    }

    if (tool_name === "browser_verify_element_visible") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_verify_element_visible", false);
      }

      const selector = this.resolve_required_selector_from_args(tab_id, args, "browser_verify_element_visible");
      return {
        tab_id,
        selector,
        element_ref: typeof args.element_ref === "string" ? args.element_ref : undefined,
        visible: selector.length > 0,
      };
    }

    if (tool_name === "browser_extract_content") {
      return {
        tab_id,
        mode: typeof args.mode === "string" ? args.mode : "auto",
        content: "# In-memory Extracted Content\n\nSynthetic content body.",
      };
    }

    if (tool_name === "browser_lookup") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_lookup", false);
      }

      this.require_tab(tab_id, "browser_lookup");
      const text = typeof args.text === "string" ? args.text : "";
      const selector = "button.primary-action";
      const element_ref = this.register_element_ref(tab_id, selector);
      return {
        tab_id,
        matches: text.length
          ? [
              {
                selector,
                element_ref,
                role: "button",
                name: "Primary action",
                visible: true,
                text,
              },
            ]
          : [],
      };
    }

    if (tool_name === "browser_interact") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_interact", false);
      }

      this.require_tab(tab_id, "browser_interact");
      const actions = this.normalize_interact_actions(args);
      const on_error = args.onError === "ignore" ? "ignore" : "stop";
      const results: Array<Record<string, unknown>> = [];

      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        const type = typeof action.type === "string" ? action.type : "unknown";
        let selector: string | undefined;
        try {
          selector = this.resolve_selector_from_args_optional(tab_id, action);
        } catch (error) {
          const mapped_error = error as tool_error;
          results.push({
            type,
            ok: false,
            error: mapped_error.message,
            error_code: mapped_error.code,
          });
          if (on_error === "stop") {
            throw new tool_error(mapped_error.code, mapped_error.message, mapped_error.retryable, {
              action_index: index + 1,
              results,
            });
          }
          continue;
        }
        const result: Record<string, unknown> = { type, ok: true };

        if (selector) {
          result.selector = selector;
        }

        if (typeof action.element_ref === "string") {
          result.element_ref = action.element_ref;
        }

        const has_coordinates = typeof action.x === "number" && typeof action.y === "number";
        if (
          (type === "click" ||
            type === "hover" ||
            type === "type" ||
            type === "clear" ||
            type === "select_option" ||
            type === "file_upload" ||
            type === "force_pseudo_state" ||
            type === "scroll_into_view") &&
          !selector
        ) {
          result.ok = false;
          result.error_code = "INVALID_ARGUMENT";
          result.error = "selector or element_ref is required";
        }

        if ((type === "mouse_click" || type === "mouse_move") && !selector && !has_coordinates) {
          result.ok = false;
          result.error_code = "INVALID_ARGUMENT";
          result.error = "selector or element_ref or x/y coordinates are required";
        }

        if (type === "type") {
          result.value = typeof action.text === "string" ? action.text : "";
        }

        if (type === "file_upload") {
          const files = Array.isArray(action.files) ? action.files.filter((value): value is string => typeof value === "string") : [];
          if (files.length === 0) {
            result.ok = false;
            result.error_code = "INVALID_ARGUMENT";
            result.error = "file_upload requires non-empty files[]";
          } else {
            result.files = files;
          }
        }

        if (type === "force_pseudo_state") {
          const pseudo_states = Array.isArray(action.pseudoStates)
            ? action.pseudoStates.filter((value): value is string => typeof value === "string")
            : typeof action.pseudo === "string"
              ? [action.pseudo]
              : typeof action.value === "string"
                ? [action.value]
                : [];

          if (pseudo_states.length === 0 && !Array.isArray(action.pseudoStates)) {
            result.ok = false;
            result.error_code = "INVALID_ARGUMENT";
            result.error = "force_pseudo_state requires pseudoStates or pseudo";
          } else {
            result.pseudo_states = pseudo_states;
          }
        }

        results.push(result);

        if (!result.ok && on_error === "stop") {
          throw new tool_error(
            "INVALID_ARGUMENT",
            String(result.error ?? `interaction failed at action ${index + 1}`),
            false,
            {
              action_index: index + 1,
              results,
            },
          );
        }
      }

      return {
        tab_id,
        on_error,
        results,
      };
    }

    if (tool_name === "browser_fill_form") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_fill_form", false);
      }

      this.require_tab(tab_id, "browser_fill_form");
      const fields = Array.isArray(args.fields) ? args.fields : [];
      return {
        tab_id,
        fields: fields.map((field) => {
          const selector =
            field && typeof field === "object"
              ? this.resolve_selector_from_args_optional(tab_id, field as Record<string, unknown>)
              : undefined;

          return {
            selector,
            element_ref:
              field && typeof field === "object" && typeof (field as Record<string, unknown>).element_ref === "string"
                ? (field as Record<string, unknown>).element_ref
                : undefined,
            ok: Boolean(selector),
            error: selector ? undefined : "selector or element_ref is required",
          };
        }),
      };
    }

    if (tool_name === "browser_drag") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_drag", false);
      }

      const from_selector = this.resolve_required_selector_from_args(
        tab_id,
        {
          selector: args.fromSelector,
          element_ref: args.fromElementRef,
        },
        "browser_drag",
      );
      const to_selector = this.resolve_required_selector_from_args(
        tab_id,
        {
          selector: args.toSelector,
          element_ref: args.toElementRef,
        },
        "browser_drag",
      );

      return {
        tab_id,
        ok: true,
        from_selector,
        to_selector,
        from_element_ref: typeof args.fromElementRef === "string" ? args.fromElementRef : undefined,
        to_element_ref: typeof args.toElementRef === "string" ? args.toElementRef : undefined,
      };
    }

    if (tool_name === "browser_window") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_window", false);
      }

      const action = typeof args.action === "string" ? args.action : "";
      if (action === "resize") {
        if (typeof args.width !== "number" || args.width <= 0 || typeof args.height !== "number" || args.height <= 0) {
          throw new tool_error("INVALID_ARGUMENT", "browser_window resize requires positive width and height", false, {
            args,
          });
        }

        return {
          tab_id,
          action,
          window_id: 1,
          width: args.width,
          height: args.height,
          state: "normal",
        };
      }

      if (action === "maximize" || action === "minimize" || action === "close") {
        return {
          tab_id,
          action,
          window_id: 1,
          state: action === "maximize" ? "maximized" : action === "minimize" ? "minimized" : "closed",
          closed: action === "close",
        };
      }

      throw new tool_error("INVALID_ARGUMENT", `unsupported browser_window action: ${action}`, false, { args });
    }

    if (tool_name === "browser_get_element_styles") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_get_element_styles", false);
      }

      this.require_tab(tab_id, "browser_get_element_styles");
      const selector = this.resolve_required_selector_from_args(tab_id, args, "browser_get_element_styles");
      const property = typeof args.property === "string" ? args.property : undefined;
      return {
        tab_id,
        found: true,
        selector,
        element_ref: typeof args.element_ref === "string" ? args.element_ref : undefined,
        property,
        value: property ? "synthetic-value" : undefined,
        styles: property
          ? undefined
          : {
              display: "block",
              color: "rgb(0, 0, 0)",
            },
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

    if (tool_name === "browser_take_screenshot") {
      if (typeof tab_id !== "number") {
        throw new tool_error("INVALID_ARGUMENT", "tab_id is required for browser_take_screenshot", false);
      }

      this.require_tab(tab_id, "browser_take_screenshot");
      const format = args.type === "png" ? "png" : "jpeg";
      const mime_type = format === "png" ? "image/png" : "image/jpeg";
      const resolved_selector = this.resolve_selector_from_args_optional(tab_id, args);
      const data_base64 =
        format === "png"
          ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nXrkAAAAASUVORK5CYII="
          : "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBIVFRUVFRUVFRUVFRUVFRUVFRUXFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGi0fHR0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBEQACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB6A//xAAZEAEAAwEBAAAAAAAAAAAAAAABAAIRITH/2gAIAQEAAT8AmW0q1//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Af//Z";
      const capture_mode =
        typeof resolved_selector === "string" && resolved_selector.length > 0
          ? "selector"
          : typeof args.clip_x === "number" &&
              typeof args.clip_y === "number" &&
              typeof args.clip_width === "number" &&
              typeof args.clip_height === "number"
            ? "clip"
            : args.fullPage === true
              ? "full_page"
              : "viewport";

      return {
        tab_id,
        data_base64,
        mime_type,
        format,
        bytes: Buffer.from(data_base64, "base64").byteLength,
        capture_mode,
        full_page: capture_mode === "full_page",
        selector: resolved_selector,
        element_ref: typeof args.element_ref === "string" ? args.element_ref : undefined,
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

  public set_on_ui_admin_request(
    handler: (
      request_id: string,
      action: ui_admin_request["action"],
      payload: Record<string, unknown>,
    ) => Promise<ui_admin_request_result>,
  ): void {
    this.on_ui_admin_request_handler = handler;
  }

  public async publish_connections_snapshot(snapshot: connections_snapshot): Promise<void> {
    this.last_connections_snapshot = JSON.parse(JSON.stringify(snapshot)) as connections_snapshot;
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

  private get_element_ref_store(tab_id: number): Map<string, string> {
    let store = this.element_refs_by_tab.get(tab_id);
    if (!store) {
      store = new Map<string, string>();
      this.element_refs_by_tab.set(tab_id, store);
    }

    return store;
  }

  private reset_element_refs_for_tab(tab_id: number): void {
    this.element_refs_by_tab.set(tab_id, new Map<string, string>());
    this.element_ref_revision_by_tab.set(tab_id, (this.element_ref_revision_by_tab.get(tab_id) ?? 0) + 1);
  }

  private register_element_ref(tab_id: number, selector: string): string {
    const store = this.get_element_ref_store(tab_id);
    const revision = this.element_ref_revision_by_tab.get(tab_id) ?? 0;
    const element_ref = `el_${tab_id}_${revision}_${store.size + 1}`;
    store.set(element_ref, selector);
    return element_ref;
  }

  private resolve_selector_from_args_optional(tab_id: number, args: Record<string, unknown>): string | undefined {
    const selector = typeof args.selector === "string" ? args.selector : undefined;
    if (selector && selector.length > 0) {
      return selector;
    }

    const element_ref = typeof args.element_ref === "string" ? args.element_ref : undefined;
    if (!element_ref) {
      return undefined;
    }

    const resolved_selector = this.get_element_ref_store(tab_id).get(element_ref);
    if (!resolved_selector) {
      throw new tool_error("STALE_ELEMENT_REFERENCE", `element_ref is stale: ${element_ref}`, false, {
        tab_id,
        element_ref,
      });
    }

    return resolved_selector;
  }

  private resolve_required_selector_from_args(tab_id: number, args: Record<string, unknown>, tool_name: string): string {
    const selector = this.resolve_selector_from_args_optional(tab_id, args);
    if (!selector) {
      throw new tool_error("INVALID_ARGUMENT", `${tool_name} requires selector or element_ref`, false, {
        tab_id,
      });
    }

    return selector;
  }

  private normalize_interact_actions(args: Record<string, unknown>): Array<Record<string, unknown>> {
    const actions = Array.isArray(args.actions)
      ? args.actions.filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === "object")
      : [];

    if (actions.length > 0) {
      return actions;
    }

    if (typeof args.action === "string") {
      return [{ ...args, type: args.action }];
    }

    throw new tool_error("INVALID_ARGUMENT", "browser_interact requires action or non-empty actions[]", false);
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
  private on_ui_admin_request_handler?: (
    request_id: string,
    action: ui_admin_request["action"],
    payload: Record<string, unknown>,
  ) => Promise<ui_admin_request_result>;

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
        error: (socket, error) => this.handle_socket_error(socket, error),
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

  public set_on_ui_admin_request(
    handler: (
      request_id: string,
      action: ui_admin_request["action"],
      payload: Record<string, unknown>,
    ) => Promise<ui_admin_request_result>,
  ): void {
    this.on_ui_admin_request_handler = handler;
  }

  public async publish_connections_snapshot(snapshot: connections_snapshot): Promise<void> {
    if (!this.extension_socket || this.state !== "up") {
      return;
    }

    this.extension_socket.send(JSON.stringify(snapshot));
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
    const previous_socket = this.extension_socket;
    this.extension_socket = socket;
    this.set_state("up");

    if (previous_socket && previous_socket !== socket) {
      previous_socket.close(1013, "single extension connection required");
    }
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

    if ("type" in parsed && parsed.type === "ui_admin_request") {
      void this.handle_ui_admin_request(parsed);
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

  private handle_socket_close(socket: ServerWebSocket<ws_data>): void {
    if (!this.extension_socket || socket !== this.extension_socket) {
      return;
    }

    this.extension_socket = undefined;
    this.set_state("reconnecting");

    for (const pending of this.pending_requests.values()) {
      clearTimeout(pending.timeout_id);
      pending.reject(new tool_error("EXTENSION_UNAVAILABLE", "extension disconnected", true));
    }

    this.pending_requests.clear();
  }

  private handle_socket_error(socket: ServerWebSocket<ws_data>, _error: Error): void {
    if (this.extension_socket && socket !== this.extension_socket) {
      return;
    }

    if (!this.extension_socket) {
      this.set_state("down");
      return;
    }

    this.set_state("reconnecting");
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
      const index = casted_row.index;
      const active = casted_row.active;
      const window_id = casted_row.window_id;
      const stealth = casted_row.stealth;

      if (
        typeof tab_id !== "number" ||
        typeof url !== "string" ||
        typeof title !== "string" ||
        typeof debugger_attached !== "boolean"
      ) {
        continue;
      }

      parsed_tabs.push({
        tab_id,
        url,
        title,
        debugger_attached,
        index: typeof index === "number" ? index : undefined,
        active: typeof active === "boolean" ? active : undefined,
        window_id: typeof window_id === "number" ? window_id : undefined,
        stealth: typeof stealth === "boolean" ? stealth : undefined,
      });
    }

    return parsed_tabs;
  }

  private async handle_ui_admin_request(request: ui_admin_request): Promise<void> {
    let response: ui_admin_response;
    if (!this.on_ui_admin_request_handler) {
      response = {
        type: "ui_admin_response",
        request_id: request.request_id,
        ok: false,
        error: "ui admin handler unavailable",
      };
    } else {
      try {
        const result = await this.on_ui_admin_request_handler(request.request_id, request.action, request.payload);
        response = {
          type: "ui_admin_response",
          request_id: request.request_id,
          ok: result.ok,
          result: result.result,
          error: result.error,
        };
      } catch (error) {
        response = {
          type: "ui_admin_response",
          request_id: request.request_id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (!this.extension_socket || this.state !== "up") {
      return;
    }

    this.extension_socket.send(JSON.stringify(response));
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
      const fallback_error_code =
        pending.action === "detach_from_tab"
          ? "DETACH_FAILED"
          : pending.action === "call_tool"
            ? "TOOL_FAILED"
            : "ATTACH_FAILED";
      pending.reject(
        new tool_error(
          typeof response.error_code === "string" ? response.error_code : fallback_error_code,
          response.error ?? "extension request failed",
          response.retryable === true,
          response.error_details && typeof response.error_details === "object"
            ? (response.error_details as Record<string, unknown>)
            : undefined,
        ),
      );
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
      const timeout_action =
        action === "call_tool" && typeof payload.tool_name === "string"
          ? `call_tool:${payload.tool_name}`
          : action;

      const timeout_id = setTimeout(() => {
        this.pending_requests.delete(request_id);
        reject(new tool_error("TIMEOUT", `extension request timed out: ${timeout_action}`, true));
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
