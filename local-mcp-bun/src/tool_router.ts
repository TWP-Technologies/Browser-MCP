import { tool_error, to_tool_error } from "./errors";
import { merge_tabs_with_locks, type bridge_transport } from "./bridge_transport";
import { session_registry } from "./session_registry";
import { tab_lock_manager } from "./tab_lock_manager";
import type {
  attach_to_tab_input,
  connections_snapshot,
  detach_from_tab_input,
  listed_tab_snapshot,
  lock_snapshot,
  ui_admin_request,
} from "./types";

interface router_options {
  auth_token?: string;
}

interface close_all_sessions_result {
  attempted_session_ids: string[];
  closed_session_ids: string[];
  failed: Array<{
    agent_session_id: string;
    error: string;
  }>;
}

const passthrough_tools = [
  "browser_navigate",
  "browser_interact",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_evaluate",
  "browser_console_messages",
  "browser_fill_form",
  "browser_drag",
  "browser_window",
  "browser_verify_text_visible",
  "browser_verify_element_visible",
  "browser_network_requests",
  "browser_pdf_save",
  "browser_handle_dialog",
  "browser_list_extensions",
  "browser_reload_extensions",
  "browser_performance_metrics",
  "browser_extract_content",
  "browser_lookup",
  "browser_get_element_styles",
] as const;

const system_agent_session_id = "system-router";

export class tool_router {
  private readonly session_registry: session_registry;
  private readonly tab_lock_manager: tab_lock_manager;
  private readonly bridge_transport: bridge_transport;
  private readonly auth_token?: string;
  private readonly active_tab_by_session: Map<string, number>;
  private reconcile_in_progress: boolean;

  public constructor(
    session_registry_instance: session_registry,
    tab_lock_manager_instance: tab_lock_manager,
    bridge_transport_instance: bridge_transport,
    options: router_options = {},
  ) {
    this.session_registry = session_registry_instance;
    this.tab_lock_manager = tab_lock_manager_instance;
    this.bridge_transport = bridge_transport_instance;
    this.auth_token = options.auth_token;
    this.active_tab_by_session = new Map<string, number>();
    this.reconcile_in_progress = false;

    this.bridge_transport.set_on_detach((tab_id) => {
      this.handle_detach_notice(tab_id);
    });

    this.bridge_transport.set_on_state_change((state) => {
      if (state !== "up") {
        return;
      }

      void (async () => {
        await this.reconcile_locks_with_bridge("state_change_up");
        await this.publish_connections_snapshot("state_change_up");
      })();
    });

    this.bridge_transport.set_on_ui_admin_request(async (request_id, action, payload) => {
      return await this.handle_ui_admin_request(request_id, action, payload);
    });
  }

  public open_session(client_name?: string, supplied_token?: string): { agent_session_id: string } {
    const auth_mode = this.assert_token_if_required(supplied_token);
    const session = this.session_registry.create_session(client_name, auth_mode);
    void this.publish_connections_snapshot("open_session");
    return { agent_session_id: session.agent_session_id };
  }

  public async close_session(agent_session_id: string): Promise<{ released_tab_ids: number[] }> {
    this.active_tab_by_session.delete(agent_session_id);
    const released_tab_ids = this.session_registry.close_session(agent_session_id);

    for (const tab_id of released_tab_ids) {
      try {
        await this.bridge_transport.detach_from_tab(tab_id, agent_session_id);
      } catch {
        // Lock release is still required even if detach call fails.
      }

      try {
        this.tab_lock_manager.release_lock(tab_id, agent_session_id);
      } catch {
        // Lock may already be released.
      }
    }

    await this.publish_connections_snapshot("close_session");
    return { released_tab_ids };
  }

  public list_tools(): Array<Record<string, unknown>> {
    const base_tools: Array<Record<string, unknown>> = [
      {
        name: "list_available_tabs",
        description:
          "Returns all open tabs with lock metadata, including tab_id, url, title, and is_locked_by_agent",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "attach_to_tab",
        description:
          "Acquires lock ownership and attaches debugger for a tab. Returns lock conflict if another agent owns the lock.",
        inputSchema: {
          type: "object",
          properties: {
            tab_id: { type: "number", minimum: 1 },
            wait_timeout_ms: { type: "number", minimum: 1, maximum: 120000 },
          },
          required: ["tab_id"],
        },
      },
      {
        name: "detach_from_tab",
        description: "Detaches debugger and releases lock ownership for a tab",
        inputSchema: {
          type: "object",
          properties: {
            tab_id: { type: "number", minimum: 1 },
          },
          required: ["tab_id"],
        },
      },
    ];

    for (const tool_name of passthrough_tools) {
      if (tool_name === "browser_take_screenshot") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_take_screenshot. Captures viewport, full-page, selector, or clipped screenshots from the attached tab.",
          inputSchema: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["jpeg", "png"] },
              quality: { type: "number", minimum: 0, maximum: 100 },
              fullPage: { type: "boolean" },
              selector: { type: "string" },
              padding: { type: "number", minimum: 0 },
              clip_x: { type: "number" },
              clip_y: { type: "number" },
              clip_width: { type: "number", exclusiveMinimum: 0 },
              clip_height: { type: "number", exclusiveMinimum: 0 },
              clip_coordinateSystem: { type: "string", enum: ["viewport", "page"] },
            },
          },
        });
        continue;
      }

      base_tools.push({
        name: tool_name,
        description: `Forwarded browser tool: ${tool_name}`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      });
    }

    base_tools.push({
      name: "browser_tabs",
      description: "Tab management tool forwarded to extension with lock-aware attach/new/close routing",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          index: { type: "number" },
          url: { type: "string" },
          tab_id: { type: "number" },
        },
        required: ["action"],
      },
    });

    return base_tools;
  }

  public async call_tool(
    agent_session_id: string,
    tool_name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.session_registry.touch_session(agent_session_id);
    await this.reconcile_locks_with_bridge("call_tool");

    if (tool_name === "list_available_tabs") {
      const tabs = await this.list_available_tabs(agent_session_id);
      return { tabs };
    }

    if (tool_name === "attach_to_tab") {
      const parsed_args = this.parse_attach_args(args);
      return await this.attach_to_tab(agent_session_id, parsed_args);
    }

    if (tool_name === "detach_from_tab") {
      const parsed_args = this.parse_detach_args(args);
      return await this.detach_from_tab(agent_session_id, parsed_args);
    }

    if (tool_name === "browser_tabs") {
      return await this.handle_browser_tabs(agent_session_id, args);
    }

    if (passthrough_tools.includes(tool_name as (typeof passthrough_tools)[number])) {
      return await this.call_tab_scoped_tool(agent_session_id, tool_name, args);
    }

    throw new tool_error("INVALID_ARGUMENT", `unknown tool: ${tool_name}`, false, {
      tool_name,
    });
  }

  public async release_locks_for_session(agent_session_id: string): Promise<number[]> {
    const released_tab_ids = this.tab_lock_manager.release_locks_by_owner(agent_session_id);
    this.active_tab_by_session.delete(agent_session_id);

    for (const tab_id of released_tab_ids) {
      try {
        await this.bridge_transport.detach_from_tab(tab_id, agent_session_id);
      } catch {
        // cleanup is best-effort for disconnected bridge state
      }
    }

    await this.publish_connections_snapshot("release_locks_for_session");
    return released_tab_ids;
  }

  public async reconcile_locks_with_bridge(reason: string): Promise<void> {
    if (this.bridge_transport.get_state() !== "up") {
      return;
    }

    if (this.reconcile_in_progress) {
      return;
    }

    this.reconcile_in_progress = true;
    let changed = false;

    try {
      const tabs = await this.bridge_transport.list_tabs(this.get_system_agent_session_id(reason));
      const tabs_by_id = new Map<number, { debugger_attached: boolean }>();

      for (const tab of tabs) {
        tabs_by_id.set(tab.tab_id, {
          debugger_attached: tab.debugger_attached,
        });
      }

      for (const lock of this.tab_lock_manager.list_locks()) {
        const tab_state = tabs_by_id.get(lock.tab_id);
        if (tab_state?.debugger_attached) {
          continue;
        }

        const owner_agent_session_id = lock.owner_agent_session_id;
        try {
          this.tab_lock_manager.release_lock(lock.tab_id, owner_agent_session_id);
        } catch {
          this.tab_lock_manager.release_lock(lock.tab_id);
        }
        changed = true;

        try {
          this.session_registry.mark_tab_released(owner_agent_session_id, lock.tab_id);
        } catch {
          // session may have already closed
        }

        if (this.active_tab_by_session.get(owner_agent_session_id) === lock.tab_id) {
          this.active_tab_by_session.delete(owner_agent_session_id);
        }
      }
    } catch {
      // Reconciliation is best-effort and retried automatically.
    } finally {
      this.reconcile_in_progress = false;
      if (changed) {
        await this.publish_connections_snapshot("reconcile_locks_with_bridge");
      }
      void reason;
    }
  }

  private assert_token_if_required(supplied_token?: string): "none" | "token" {
    if (!this.auth_token) {
      return "none";
    }

    if (supplied_token !== this.auth_token) {
      throw new tool_error("UNAUTHORIZED", "invalid token", false);
    }

    return "token";
  }

  private get_system_agent_session_id(reason: string): string {
    return `${system_agent_session_id}:${reason}`;
  }

  private async list_available_tabs(agent_session_id: string): Promise<listed_tab_snapshot[]> {
    const tabs = await this.bridge_transport.list_tabs(agent_session_id);
    const lock_owner_by_tab_id = new Map<number, string>();

    for (const lock of this.tab_lock_manager.list_locks()) {
      lock_owner_by_tab_id.set(lock.tab_id, lock.owner_agent_session_id);
    }

    return merge_tabs_with_locks(tabs, lock_owner_by_tab_id);
  }

  private async attach_to_tab(
    agent_session_id: string,
    input: attach_to_tab_input,
  ): Promise<{ tab_id: number; attached: boolean; owner_agent_session_id: string }> {
    const lock = await this.tab_lock_manager.acquire_lock(input.tab_id, agent_session_id, input.wait_timeout_ms);

    try {
      this.tab_lock_manager.set_lock_state(input.tab_id, "pending_attach");
      await this.bridge_transport.attach_to_tab(input.tab_id, agent_session_id);
      this.tab_lock_manager.set_lock_state(input.tab_id, "attached");
      this.session_registry.mark_tab_owned(agent_session_id, input.tab_id);
      this.active_tab_by_session.set(agent_session_id, input.tab_id);
      await this.publish_connections_snapshot("attach_to_tab");

      return {
        tab_id: input.tab_id,
        attached: true,
        owner_agent_session_id: lock.owner_agent_session_id,
      };
    } catch (error) {
      try {
        this.tab_lock_manager.release_lock(input.tab_id, agent_session_id);
      } catch {
        // ignore cleanup failure
      }

      const mapped_error = to_tool_error(error);

      if (mapped_error.code === "ATTACH_FAILED") {
        throw mapped_error;
      }

      throw new tool_error("ATTACH_FAILED", mapped_error.message, mapped_error.retryable, mapped_error.details);
    }
  }

  private async detach_from_tab(
    agent_session_id: string,
    input: detach_from_tab_input,
  ): Promise<{ tab_id: number; detached: boolean }> {
    const active_lock = this.tab_lock_manager.get_lock(input.tab_id);

    if (!active_lock) {
      return { tab_id: input.tab_id, detached: true };
    }

    if (active_lock.owner_agent_session_id !== agent_session_id) {
      throw new tool_error("LOCK_NOT_OWNED", `tab ${input.tab_id} is owned by ${active_lock.owner_agent_session_id}`, false, {
        tab_id: input.tab_id,
        owner_agent_session_id: active_lock.owner_agent_session_id,
        agent_session_id,
      });
    }

    this.tab_lock_manager.set_lock_state(input.tab_id, "releasing");

    try {
      await this.bridge_transport.detach_from_tab(input.tab_id, agent_session_id);
    } catch (error) {
      throw new tool_error("DETACH_FAILED", to_tool_error(error).message, true, {
        tab_id: input.tab_id,
      });
    }

    this.tab_lock_manager.release_lock(input.tab_id, agent_session_id);
    this.session_registry.mark_tab_released(agent_session_id, input.tab_id);
    const active_tab_id = this.active_tab_by_session.get(agent_session_id);
    if (active_tab_id === input.tab_id) {
      this.active_tab_by_session.delete(agent_session_id);
    }
    await this.publish_connections_snapshot("detach_from_tab");

    return {
      tab_id: input.tab_id,
      detached: true,
    };
  }

  private parse_attach_args(args: Record<string, unknown>): attach_to_tab_input {
    const tab_id = args.tab_id;
    const wait_timeout_ms = args.wait_timeout_ms;

    if (typeof tab_id !== "number" || !Number.isInteger(tab_id) || tab_id <= 0) {
      throw new tool_error("INVALID_ARGUMENT", "tab_id must be a positive integer", false, {
        tab_id,
      });
    }

    if (
      wait_timeout_ms !== undefined &&
      (typeof wait_timeout_ms !== "number" || !Number.isInteger(wait_timeout_ms) || wait_timeout_ms <= 0)
    ) {
      throw new tool_error("INVALID_ARGUMENT", "wait_timeout_ms must be a positive integer", false, {
        wait_timeout_ms,
      });
    }

    return {
      tab_id,
      wait_timeout_ms: wait_timeout_ms as number | undefined,
    };
  }

  private parse_detach_args(args: Record<string, unknown>): detach_from_tab_input {
    const tab_id = args.tab_id;

    if (typeof tab_id !== "number" || !Number.isInteger(tab_id) || tab_id <= 0) {
      throw new tool_error("INVALID_ARGUMENT", "tab_id must be a positive integer", false, {
        tab_id,
      });
    }

    return { tab_id };
  }

  private handle_detach_notice(tab_id: number): void {
    const active_lock = this.tab_lock_manager.get_lock(tab_id);
    if (!active_lock) {
      return;
    }

    const owner_agent_session_id = active_lock.owner_agent_session_id;

    try {
      this.tab_lock_manager.release_lock(tab_id, owner_agent_session_id);
    } catch {
      this.tab_lock_manager.release_lock(tab_id);
    }

    try {
      this.session_registry.mark_tab_released(owner_agent_session_id, tab_id);
    } catch {
      // session may have closed already
    }

    const active_tab_id = this.active_tab_by_session.get(owner_agent_session_id);
    if (active_tab_id === tab_id) {
      this.active_tab_by_session.delete(owner_agent_session_id);
    }

    void this.publish_connections_snapshot("detach_notice");
  }

  private async handle_browser_tabs(
    agent_session_id: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const action = args.action;
    if (typeof action !== "string") {
      throw new tool_error("INVALID_ARGUMENT", "browser_tabs requires string action", false, { args });
    }

    if (action === "list") {
      const raw = (await this.bridge_transport.call_tool("browser_tabs", { action: "list" }, agent_session_id)) as {
        tabs?: Array<Record<string, unknown>>;
      };

      const source_tabs = Array.isArray(raw.tabs) ? raw.tabs : [];
      const owner_by_tab_id = new Map<number, string>();

      for (const lock of this.tab_lock_manager.list_locks()) {
        owner_by_tab_id.set(lock.tab_id, lock.owner_agent_session_id);
      }

      const tabs = source_tabs.map((tab) => {
        const tab_id = tab.tab_id;
        if (typeof tab_id !== "number") {
          return {
            ...tab,
            is_locked_by_agent: false,
          };
        }

        const owner = owner_by_tab_id.get(tab_id);
        if (!owner) {
          return {
            ...tab,
            is_locked_by_agent: false,
          };
        }

        return {
          ...tab,
          is_locked_by_agent: true,
          locked_by_agent_session_id: owner,
        };
      });

      return { tabs };
    }

    if (action === "attach") {
      const index = args.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        throw new tool_error("INVALID_ARGUMENT", "browser_tabs attach requires non-negative integer index", false, {
          args,
        });
      }

      const tabs_response = (await this.bridge_transport.call_tool(
        "browser_tabs",
        { action: "list" },
        agent_session_id,
      )) as {
        tabs?: Array<Record<string, unknown>>;
      };

      const tabs = Array.isArray(tabs_response.tabs) ? tabs_response.tabs : [];
      const matched_tab = tabs.find((tab) => tab.index === index);

      const tab_id = matched_tab?.tab_id;
      if (typeof tab_id !== "number") {
        throw new tool_error("TAB_NOT_FOUND", `tab index ${index} not found`, false, { index });
      }

      const attach_result = await this.attach_to_tab(agent_session_id, { tab_id });
      return {
        action: "attach",
        ...attach_result,
      };
    }

    if (action === "new") {
      const create_result = (await this.bridge_transport.call_tool("browser_tabs", {
        action: "new",
        url: typeof args.url === "string" ? args.url : "about:blank",
      }, agent_session_id)) as Record<string, unknown>;

      const tab_id = create_result.tab_id;
      if (typeof tab_id !== "number") {
        throw new tool_error("ATTACH_FAILED", "extension failed to return tab_id for new tab", false, {
          create_result,
        });
      }

      const attach_result = await this.attach_to_tab(agent_session_id, { tab_id });
      return {
        action: "new",
        ...attach_result,
        created_tab: create_result,
      };
    }

    if (action === "close") {
      const explicit_tab_id = args.tab_id;
      const tab_id =
        typeof explicit_tab_id === "number" && Number.isInteger(explicit_tab_id) && explicit_tab_id > 0
          ? explicit_tab_id
          : this.active_tab_by_session.get(agent_session_id);

      await this.bridge_transport.call_tool(
        "browser_tabs",
        {
          action: "close",
          tab_id,
        },
        agent_session_id,
      );

      if (typeof tab_id === "number") {
        try {
          await this.detach_from_tab(agent_session_id, { tab_id });
        } catch (error) {
          if (!(error instanceof tool_error) || error.code !== "LOCK_NOT_OWNED") {
            throw error;
          }
        }
      }

      return {
        action: "close",
        tab_id,
        closed: true,
      };
    }

    throw new tool_error("INVALID_ARGUMENT", `unsupported browser_tabs action: ${action}`, false, { action });
  }

  private async handle_ui_admin_request(
    _request_id: string,
    action: ui_admin_request["action"],
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (action === "close_session") {
      const agent_session_id = payload.agent_session_id;
      if (typeof agent_session_id !== "string" || agent_session_id.length === 0) {
        return {
          ok: false,
          error: "close_session requires non-empty agent_session_id",
        };
      }

      try {
        const result = await this.close_session(agent_session_id);
        return {
          ok: true,
          result,
        };
      } catch (error) {
        const mapped_error = to_tool_error(error);
        return {
          ok: false,
          error: mapped_error.message,
        };
      }
    }

    if (action === "close_all_sessions") {
      const result = await this.close_all_sessions_for_ui();
      return {
        ok: true,
        result,
      };
    }

    if (action === "detach_tab_lock") {
      const tab_id = payload.tab_id;
      if (typeof tab_id !== "number" || !Number.isInteger(tab_id) || tab_id <= 0) {
        return {
          ok: false,
          error: "detach_tab_lock requires positive integer tab_id",
        };
      }

      const active_lock = this.tab_lock_manager.get_lock(tab_id);
      if (!active_lock) {
        return {
          ok: true,
          result: {
            tab_id,
            detached: true,
            lock_found: false,
          },
        };
      }

      try {
        await this.detach_from_tab(active_lock.owner_agent_session_id, {
          tab_id,
        });
        return {
          ok: true,
          result: {
            tab_id,
            detached: true,
            lock_found: true,
            owner_agent_session_id: active_lock.owner_agent_session_id,
          },
        };
      } catch (error) {
        const mapped_error = to_tool_error(error);
        return {
          ok: false,
          error: mapped_error.message,
        };
      }
    }

    return {
      ok: false,
      error: `unsupported ui_admin_request action: ${action}`,
    };
  }

  private async close_all_sessions_for_ui(): Promise<close_all_sessions_result> {
    const active_sessions = this.session_registry.list_active_sessions().sort((left, right) => left.localeCompare(right));
    const closed_session_ids: string[] = [];
    const failed: close_all_sessions_result["failed"] = [];

    for (const agent_session_id of active_sessions) {
      try {
        await this.close_session(agent_session_id);
        closed_session_ids.push(agent_session_id);
      } catch (error) {
        const mapped_error = to_tool_error(error);
        failed.push({
          agent_session_id,
          error: mapped_error.message,
        });
      }
    }

    return {
      attempted_session_ids: active_sessions,
      closed_session_ids,
      failed,
    };
  }

  private build_connections_snapshot(): connections_snapshot {
    const sessions = this.session_registry.list_session_snapshots();
    const locks: lock_snapshot[] = this.tab_lock_manager
      .list_locks()
      .map((lock) => ({
        tab_id: lock.tab_id,
        owner_agent_session_id: lock.owner_agent_session_id,
        lock_state: lock.lock_state,
        lock_acquired_at: lock.lock_acquired_at,
      }))
      .sort((left, right) => left.tab_id - right.tab_id);

    return {
      type: "connections_snapshot",
      generated_at: new Date().toISOString(),
      sessions,
      locks,
    };
  }

  private async publish_connections_snapshot(reason: string): Promise<void> {
    if (this.bridge_transport.get_state() !== "up") {
      return;
    }

    try {
      await this.bridge_transport.publish_connections_snapshot(this.build_connections_snapshot());
    } catch {
      // Snapshot broadcast is best-effort.
    } finally {
      void reason;
    }
  }

  private async call_tab_scoped_tool(
    agent_session_id: string,
    tool_name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const active_tab_id = this.active_tab_by_session.get(agent_session_id);
    if (typeof active_tab_id !== "number") {
      throw new tool_error(
        "INVALID_ARGUMENT",
        `${tool_name} requires an attached tab. Use attach_to_tab or browser_tabs action=attach/new first.`,
        false,
      );
    }

    const lock = this.tab_lock_manager.get_lock(active_tab_id);
    if (!lock || lock.owner_agent_session_id !== agent_session_id) {
      throw new tool_error("LOCK_NOT_OWNED", `session no longer owns tab ${active_tab_id}`, false, {
        active_tab_id,
        agent_session_id,
      });
    }

    const result = await this.bridge_transport.call_tool(tool_name, args, agent_session_id, active_tab_id);

    if (result && typeof result === "object") {
      return result as Record<string, unknown>;
    }

    return { result };
  }
}
