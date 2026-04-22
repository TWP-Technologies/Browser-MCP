import { Buffer } from "node:buffer";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  stale_session_timeout_minutes?: number;
}

interface close_all_sessions_result {
  attempted_session_ids: string[];
  closed_session_ids: string[];
  failed: Array<{
    agent_session_id: string;
    error: string;
  }>;
}

interface close_session_result {
  released_tab_ids: number[];
  cancelled_waiting_tab_ids: number[];
}

interface stale_session_cleanup_result {
  stale_session_timeout_minutes: number;
  stale_session_ids: string[];
  closed_session_ids: string[];
  failed: Array<{
    agent_session_id: string;
    error: string;
  }>;
}

interface invalid_argument_details_options {
  args?: Record<string, unknown>;
  provided_fields?: string[];
  recovery_hint: string;
  canonical_example?: Record<string, unknown>;
  expected_fields?: string[];
  accepted_aliases?: string[];
  owned_tab_ids?: number[];
  recommended_next_tools?: string[];
}

interface prompt_argument_definition {
  name: string;
  description: string;
  required: boolean;
}

interface prompt_definition {
  description: string;
  arguments?: prompt_argument_definition[];
  render: (prompt_args: Record<string, unknown>) => string;
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
const artifact_root = resolve(process.cwd());
const artifact_root_real = realpathSync(artifact_root);
const default_stale_session_timeout_minutes = 120;
const max_stale_session_timeout_minutes = 10_080;

function render_learn_browser_mcp_prompt(_prompt_args: Record<string, unknown>): string {
  return [
    "# Learn Browser MCP",
    "",
    "## Operating model",
    "- This server multiplexes multiple MCP clients through one browser extension and enforces one lock owner per tab.",
    "- Any `browser_*` tool requires an attached tab. Start with `browser_tabs { action: 'list' }` plus `browser_tabs { action: 'attach', index }`, or `browser_tabs { action: 'new', url }`.",
    "- `browser_tabs { action: 'new' }` creates a tab and immediately attaches it for the current session.",
    "- `browser_snapshot` is the preferred first read tool after attach; use screenshots when semantic output is insufficient.",
    "",
    "## Canonical workflows",
    "1. Attach and observe: `browser_tabs { action: 'list' }` -> `browser_tabs { action: 'attach', index }` -> `browser_snapshot {}` -> `browser_lookup { text: '...' }`.",
    "2. New tab: `browser_tabs { action: 'new', url: 'https://example.com' }` -> `browser_snapshot {}`.",
    "3. Network debug: attach first -> `browser_navigate { action: 'reload' }` or `browser_navigate { url: '...' }` -> `browser_network_requests { action: 'list' }` -> `browser_network_requests { action: 'details', requestId: '...' }` -> optional replay.",
    "",
    "## Common mistakes",
    "- `browser_navigate` with only `url` is valid and defaults to `action='url'`.",
    "- `browser_network_requests` uses `requestId`; `request_id` is accepted as an alias.",
    "- `detach_from_tab` can omit `tab_id` only when the session owns exactly one tab.",
    "- Network capture starts after attach and later navigation or reload, not before.",
  ].join("\n");
}

function render_attach_and_observe_prompt(_prompt_args: Record<string, unknown>): string {
  return [
    "Attach and observe workflow:",
    "1. Call `browser_tabs { action: 'list' }` or `list_available_tabs {}`.",
    "2. Choose a tab and call `browser_tabs { action: 'attach', index: ... }` or `attach_to_tab { tab_id: ... }`.",
    "3. Call `browser_snapshot {}` first to read the page semantically.",
    "4. If you need a specific target, call `browser_lookup { text: '...' }` and prefer `element_ref` when present.",
    "5. Only after that should you use interaction or navigation tools.",
  ].join("\n");
}

function render_network_debug_flow_prompt(prompt_args: Record<string, unknown>): string {
  const url_pattern =
    typeof prompt_args.url_pattern === "string" && prompt_args.url_pattern.trim().length > 0
      ? prompt_args.url_pattern.trim()
      : "";
  const safe_url_pattern = url_pattern
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("`", "\\`")
    .replaceAll("\n", " ")
    .replaceAll("\r", "");
  const list_step =
    url_pattern.length > 0
      ? `browser_network_requests { action: 'list', urlPattern: '${safe_url_pattern}' }`
      : "browser_network_requests { action: 'list' }";

  return [
    "Network debug workflow:",
    "1. Ensure the tab is attached first.",
    "2. Trigger capture with `browser_navigate { action: 'reload' }` or by navigating to the target page.",
    `3. Call \`${list_step}\` to inspect captured request metadata.`,
    "4. Pick a `requestId` from the list rows and call `browser_network_requests { action: 'details', requestId: '...' }`.",
    "5. If needed, call `browser_network_requests { action: 'replay', requestId: '...' }`.",
    "6. Remember that list mode is metadata-only; decoded bodies are exposed by details mode.",
  ].join("\n");
}

const prompt_catalog = {
  learn_browser_mcp: {
    description: "Guided overview of the Browser MCP operating model, workflows, and common mistakes.",
    render: render_learn_browser_mcp_prompt,
  },
  attach_and_observe: {
    description: "Recommended first workflow for finding a tab, attaching, and observing page state safely.",
    render: render_attach_and_observe_prompt,
  },
  network_debug_flow: {
    description: "Recommended workflow for capturing, inspecting, and replaying network requests on an attached tab.",
    arguments: [
      {
        name: "url_pattern",
        description: "Optional urlPattern filter to use with browser_network_requests action='list'.",
        required: false,
      },
    ],
    render: render_network_debug_flow_prompt,
  },
} satisfies Record<string, prompt_definition>;

function is_within_root(root_path: string, candidate_path: string): boolean {
  const relative_path = relative(root_path, candidate_path);
  return relative_path === "" || (!relative_path.startsWith("..") && !isAbsolute(relative_path));
}

function resolve_artifact_path(requested_path: string): string {
  const candidate_path = isAbsolute(requested_path) ? resolve(requested_path) : resolve(artifact_root, requested_path);

  if (!is_within_root(artifact_root, candidate_path)) {
    throw new tool_error("INVALID_ARGUMENT", "artifact path must stay within the current workspace", false, {
      path: requested_path,
      artifact_root,
    });
  }

  return candidate_path;
}

function build_invalid_argument_details(options: invalid_argument_details_options): Record<string, unknown> {
  const details: Record<string, unknown> = {
    recovery_hint: options.recovery_hint,
  };

  if (options.args) {
    details.args = options.args;
  }

  if (options.provided_fields && options.provided_fields.length > 0) {
    details.provided_fields = options.provided_fields;
  }

  if (options.canonical_example) {
    details.canonical_example = options.canonical_example;
  }

  if (options.expected_fields && options.expected_fields.length > 0) {
    details.expected_fields = options.expected_fields;
  }

  if (options.accepted_aliases && options.accepted_aliases.length > 0) {
    details.accepted_aliases = options.accepted_aliases;
  }

  if (options.owned_tab_ids && options.owned_tab_ids.length > 0) {
    details.owned_tab_ids = options.owned_tab_ids;
  }

  if (options.recommended_next_tools && options.recommended_next_tools.length > 0) {
    details.recommended_next_tools = options.recommended_next_tools;
  }

  return details;
}

function parse_cleanup_timeout_minutes(stale_session_timeout_minutes: unknown): number {
  if (
    typeof stale_session_timeout_minutes !== "number" ||
    !Number.isInteger(stale_session_timeout_minutes) ||
    stale_session_timeout_minutes < 0
  ) {
    throw new tool_error(
      "INVALID_ARGUMENT",
      "stale_session_timeout_minutes must be an integer greater than or equal to 0",
      false,
      {
        stale_session_timeout_minutes,
      },
    );
  }

  if (stale_session_timeout_minutes > max_stale_session_timeout_minutes) {
    throw new tool_error(
      "INVALID_ARGUMENT",
      `stale_session_timeout_minutes must be less than or equal to ${max_stale_session_timeout_minutes}`,
      false,
      {
        stale_session_timeout_minutes,
        max_stale_session_timeout_minutes,
      },
    );
  }

  return stale_session_timeout_minutes;
}

function dedupe_sorted_tab_ids(tab_ids: Array<number | undefined>): number[] {
  const unique_tab_ids = new Set<number>();

  for (const tab_id of tab_ids) {
    if (typeof tab_id !== "number" || !Number.isInteger(tab_id) || tab_id <= 0) {
      continue;
    }

    unique_tab_ids.add(tab_id);
  }

  return [...unique_tab_ids].sort((left, right) => left - right);
}

export class tool_router {
  private readonly session_registry: session_registry;
  private readonly tab_lock_manager: tab_lock_manager;
  private readonly bridge_transport: bridge_transport;
  private readonly auth_token?: string;
  private readonly active_tab_by_session: Map<string, number>;
  private stale_session_timeout_minutes: number;
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
    this.stale_session_timeout_minutes =
      typeof options.stale_session_timeout_minutes === "number"
        ? parse_cleanup_timeout_minutes(options.stale_session_timeout_minutes)
        : default_stale_session_timeout_minutes;
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

  public get_stale_session_timeout_minutes(): number {
    return this.stale_session_timeout_minutes;
  }

  public set_stale_session_timeout_minutes(stale_session_timeout_minutes: number): { stale_session_timeout_minutes: number } {
    this.stale_session_timeout_minutes = parse_cleanup_timeout_minutes(stale_session_timeout_minutes);
    return {
      stale_session_timeout_minutes: this.stale_session_timeout_minutes,
    };
  }

  public async run_stale_session_cleanup(now_ms = Date.now()): Promise<stale_session_cleanup_result> {
    return await this.close_stale_sessions(this.stale_session_timeout_minutes, now_ms);
  }

  public async close_stale_sessions(
    stale_session_timeout_minutes: number,
    now_ms = Date.now(),
  ): Promise<stale_session_cleanup_result> {
    const resolved_timeout_minutes = parse_cleanup_timeout_minutes(stale_session_timeout_minutes);
    if (resolved_timeout_minutes <= 0) {
      return {
        stale_session_timeout_minutes: resolved_timeout_minutes,
        stale_session_ids: [],
        closed_session_ids: [],
        failed: [],
      };
    }

    const stale_session_ids = this.session_registry.list_stale_session_ids(resolved_timeout_minutes, now_ms);
    const closed_session_ids: string[] = [];
    const failed: stale_session_cleanup_result["failed"] = [];

    for (const agent_session_id of stale_session_ids) {
      try {
        await this.close_session_with_reason(agent_session_id, "stale_session_cleanup");
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
      stale_session_timeout_minutes: resolved_timeout_minutes,
      stale_session_ids,
      closed_session_ids,
      failed,
    };
  }

  public async close_session(agent_session_id: string): Promise<close_session_result> {
    return await this.close_session_with_reason(agent_session_id, "close_session");
  }

  public list_tools(): Array<Record<string, unknown>> {
    const base_tools: Array<Record<string, unknown>> = [
      {
        name: "learn_browser_mcp",
        description:
          "Guided overview of the browser MCP operating model, lock model, canonical workflows, and common mistakes. Use this first if the browser tool surface is unfamiliar.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_available_tabs",
        description:
          "Read-only overview of open tabs and lock ownership. Use this before attach_to_tab when you want to choose an existing tab.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "attach_to_tab",
        description:
          "Claim lock ownership for tab_id and attach the debugger. Use this before browser_* tools when you want to work on an existing tab. Returns LOCK_CONFLICT instead of stealing another session's lock.",
        inputSchema: {
          type: "object",
          properties: {
            tab_id: {
              type: "number",
              minimum: 1,
              description: "The browser tab_id to claim and attach.",
            },
            wait_timeout_ms: {
              type: "number",
              minimum: 1,
              maximum: 120000,
              description: "Optional lock wait timeout in milliseconds before returning LOCK_CONFLICT.",
            },
          },
          required: ["tab_id"],
        },
      },
      {
        name: "detach_from_tab",
        description:
          "Detach the debugger and release the lock for a tab owned by the current session. If tab_id is omitted, the server infers it only when the session owns exactly one tab.",
        inputSchema: {
          type: "object",
          properties: {
            tab_id: {
              type: "number",
              minimum: 1,
              description: "Optional explicit tab_id. Required when the session owns zero or multiple tabs.",
            },
          },
        },
      },
    ];

    for (const tool_name of passthrough_tools) {
      if (tool_name === "browser_snapshot") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_snapshot. Preferred first read tool after attach. Returns a compact semantic snapshot with optional stable element_ref targets.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        });
        continue;
      }

      if (tool_name === "browser_navigate") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_navigate. Navigates the attached tab. Canonical URL navigation is { action: 'url', url: 'https://example.com' }, but providing only url also defaults to action='url'. Use explicit actions for reload/back/forward/test_page.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["url", "back", "forward", "reload", "test_page"],
                description:
                  "Navigation mode. Use 'url' with url, or explicit history/reload/test_page actions. If omitted, url implies action='url'.",
              },
              url: {
                type: "string",
                description:
                  "Target URL. Required when action='url'. If present without action, the server assumes action='url'.",
              },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_interact") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_interact. Executes a single action or ordered actions[] against selector or element_ref targets.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                description: "Single interaction action. Required unless actions[] is provided.",
              },
              selector: { type: "string" },
              element_ref: { type: "string" },
              text: { type: "string" },
              key: { type: "string" },
              timeout: { type: "number", minimum: 0 },
              pseudo: { type: "string" },
              pseudoStates: {
                type: "array",
                items: { type: "string" },
              },
              files: {
                type: "array",
                items: { type: "string" },
              },
              value: {},
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right", "middle"] },
              clickCount: { type: "number", minimum: 1 },
              onError: { type: "string", enum: ["stop", "ignore"] },
              actions: {
                type: "array",
                minItems: 1,
                description: "Ordered interaction actions. Required unless action is provided.",
                items: {
                  type: "object",
                  properties: {
                    action: { type: "string" },
                    type: { type: "string" },
                    selector: { type: "string" },
                    element_ref: { type: "string" },
                    text: { type: "string" },
                    key: { type: "string" },
                    timeout: { type: "number", minimum: 0 },
                    pseudo: { type: "string" },
                    value: {},
                    x: { type: "number" },
                    y: { type: "number" },
                    files: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_fill_form") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_fill_form. Fills resolved fields using selector or element_ref targets.",
          inputSchema: {
            type: "object",
            properties: {
              fields: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    selector: { type: "string" },
                    element_ref: { type: "string" },
                    value: {},
                  },
                },
              },
            },
            required: ["fields"],
          },
        });
        continue;
      }

      if (tool_name === "browser_lookup") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_lookup. Finds text-like matches and returns selector plus element_ref metadata for follow-up actions.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              limit: { type: "number", minimum: 1, maximum: 50 },
            },
            required: ["text"],
          },
        });
        continue;
      }

      if (tool_name === "browser_get_element_styles") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_get_element_styles. Reads element styles using selector or element_ref targets.",
          inputSchema: {
            type: "object",
            properties: {
              selector: { type: "string" },
              element_ref: { type: "string" },
              property: { type: "string" },
              pseudoState: {
                type: "string",
                description:
                  "Single pseudo-state filter such as hover or focus. For multiple pseudo-states, prefer pseudoStates; runtime also accepts legacy pseudoState string arrays.",
              },
              pseudoStates: {
                type: "array",
                items: { type: "string" },
                description:
                  "Pseudo-state filters such as [\"hover\", \"focus\"]. Runtime also accepts a single string for convenience.",
              },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_take_screenshot") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_take_screenshot. Captures viewport, full-page, selector, element_ref, or clipped screenshots from the attached tab.",
          inputSchema: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["jpeg", "png"] },
              quality: { type: "number", minimum: 0, maximum: 100 },
              fullPage: { type: "boolean" },
              selector: { type: "string" },
              element_ref: { type: "string" },
              padding: { type: "number", minimum: 0 },
              path: { type: "string" },
              highlightClickables: { type: "boolean" },
              deviceScale: { type: "number", minimum: 0 },
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

      if (tool_name === "browser_evaluate") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_evaluate. Executes a JavaScript expression or function in the attached tab and returns structured results.",
          inputSchema: {
            type: "object",
            properties: {
              expression: {
                type: "string",
                description: "JavaScript expression to evaluate. Required unless function is provided.",
              },
              function: {
                type: "string",
                description: "JavaScript function source to execute. Required unless expression is provided.",
              },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_console_messages") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_console_messages. Returns console entries with filtering by level, text, and URL.",
          inputSchema: {
            type: "object",
            properties: {
              level: { type: "string", enum: ["log", "warn", "error", "info", "debug"] },
              text: { type: "string" },
              url: { type: "string" },
              limit: { type: "number", minimum: 1 },
              offset: { type: "number", minimum: 0 },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_drag") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_drag. Performs a drag from source to target using selector or element_ref inputs.",
          inputSchema: {
            type: "object",
            properties: {
              fromSelector: { type: "string" },
              toSelector: { type: "string" },
              fromElementRef: { type: "string" },
              toElementRef: { type: "string" },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_network_requests") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_network_requests. Lists, inspects, replays, or clears network traffic observed on the attached tab. Capture starts after attach and later navigation/reload. List is metadata-only; details and replay require requestId.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["list", "details", "replay", "clear"],
                description: "Request mode. Omit for metadata-only list. Use details or replay with requestId.",
              },
              urlPattern: {
                type: "string",
                description: "Optional substring filter applied to request URLs in action=list.",
              },
              method: { type: "string", description: "Optional HTTP method filter for action=list." },
              status: { type: "number", description: "Optional HTTP status filter for action=list." },
              resourceType: { type: "string", description: "Optional resource type filter for action=list." },
              limit: { type: "number", minimum: 1, description: "Maximum rows to return for action=list." },
              offset: { type: "number", minimum: 0, description: "Pagination offset for action=list." },
              requestId: {
                type: "string",
                description: "Canonical request identifier required for action=details and action=replay.",
              },
              request_id: {
                type: "string",
                description: "Alias for requestId accepted for LLM ergonomics.",
              },
              jsonPath: {
                type: "string",
                description: "Optional JSONPath query applied to a decoded JSON response body in action=details.",
              },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_pdf_save") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_pdf_save. Exports the attached tab as a PDF and optionally persists it to a filesystem path.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              landscape: { type: "boolean" },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_list_extensions") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_list_extensions. Lists installed browser extensions with development-state metadata.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        });
        continue;
      }

      if (tool_name === "browser_reload_extensions") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_reload_extensions. Reloads unpacked extensions and reports skipped extensions with reasons.",
          inputSchema: {
            type: "object",
            properties: {
              extensionName: { type: "string" },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_performance_metrics") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_performance_metrics. Returns structured navigation, Web Vitals, and resource summary metrics for the attached tab.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        });
        continue;
      }

      if (tool_name === "browser_extract_content") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_extract_content. Extracts page content as markdown using auto, full, or selector/element_ref modes.",
          inputSchema: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["auto", "full", "selector"] },
              selector: { type: "string" },
              element_ref: { type: "string" },
              max_lines: { type: "number", minimum: 1 },
              offset: { type: "number", minimum: 0 },
            },
          },
        });
        continue;
      }

      if (tool_name === "browser_window") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_window. Resizes, maximizes, minimizes, or closes the attached tab window.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["resize", "maximize", "minimize", "close"],
              },
              width: { type: "number", minimum: 1 },
              height: { type: "number", minimum: 1 },
            },
            required: ["action"],
          },
        });
        continue;
      }

      if (tool_name === "browser_verify_text_visible") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_verify_text_visible. Checks whether the provided text is visible in the attached tab.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
        });
        continue;
      }

      if (tool_name === "browser_verify_element_visible") {
        base_tools.push({
          name: tool_name,
          description:
            "Forwarded browser tool: browser_verify_element_visible. Checks whether the selector or element_ref target is visible in the attached tab.",
          inputSchema: {
            type: "object",
            properties: {
              selector: { type: "string" },
              element_ref: { type: "string" },
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
      description:
        "Tab management tool with lock-aware list, attach, new, and close actions. browser_tabs action='new' creates a tab and immediately attaches it for the current session.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "attach", "new", "close"],
            description: "Tab management action.",
          },
          index: { type: "number" },
          url: { type: "string" },
          tab_id: { type: "number" },
          activate: { type: "boolean" },
          stealth: { type: "boolean" },
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

    if (tool_name === "learn_browser_mcp") {
      return this.get_learn_browser_mcp_result();
    }

    if (tool_name === "list_available_tabs") {
      const tabs = await this.list_available_tabs(agent_session_id);
      return { tabs };
    }

    if (tool_name === "attach_to_tab") {
      const parsed_args = this.parse_attach_args(args);
      return await this.attach_to_tab(agent_session_id, parsed_args);
    }

    if (tool_name === "detach_from_tab") {
      const parsed_args = this.parse_detach_args(agent_session_id, args);
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
    this.tab_lock_manager.cancel_waiters_by_owner(agent_session_id);
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

  public get_initialize_instructions(): string {
    return [
      "This browser MCP multiplexes sessions through one extension and enforces one lock owner per tab.",
      "Use prompts/get name=learn_browser_mcp or tools/call learn_browser_mcp if the tool surface is unfamiliar.",
      "Any browser_* tool requires an attached tab. Either list tabs and attach with browser_tabs action='attach' or attach_to_tab, or create a new tab with browser_tabs action='new', which attaches automatically.",
      "browser_network_requests only captures requests observed after attach and later navigation/reload.",
      "When you are done, prefer detach_from_tab for owned tabs and session/close for explicit session shutdown.",
    ].join(" ");
  }

  public list_prompts(): Array<Record<string, unknown>> {
    return Object.entries(prompt_catalog).map(([name, prompt_definition]) => {
      const prompt_record: Record<string, unknown> = {
        name,
        description: prompt_definition.description,
      };

      if (prompt_definition.arguments) {
        prompt_record.arguments = prompt_definition.arguments;
      }

      return prompt_record;
    });
  }

  public get_prompt(name: string, prompt_args: Record<string, unknown> = {}): Record<string, unknown> {
    const prompt_catalog_by_name = prompt_catalog as Record<string, prompt_definition | undefined>;
    const prompt_definition = Object.prototype.hasOwnProperty.call(prompt_catalog, name)
      ? prompt_catalog_by_name[name]
      : undefined;
    if (!prompt_definition) {
      throw new tool_error("INVALID_ARGUMENT", `unknown prompt: ${name}`, false, {
        name,
        recovery_hint: "Call prompts/list to discover the available guidance prompts.",
      });
    }

    const messages = [
      {
        role: "user",
        content: {
          type: "text",
          text: prompt_definition.render(prompt_args),
        },
      },
    ];

    return {
      description: prompt_definition.description,
      messages,
    };
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
  ): Promise<{
    tab_id: number;
    attached: boolean;
    owner_agent_session_id: string;
    debugger_attached: boolean;
    owned_by_current_session: boolean;
    recommended_next_tools: string[];
  }> {
    const lock = await this.tab_lock_manager.acquire_lock(input.tab_id, agent_session_id, input.wait_timeout_ms);

    try {
      this.assert_session_is_active(agent_session_id);
      this.tab_lock_manager.set_lock_state(input.tab_id, "pending_attach");
      await this.bridge_transport.attach_to_tab(input.tab_id, agent_session_id);
      this.assert_session_is_active(agent_session_id);
      this.tab_lock_manager.set_lock_state(input.tab_id, "attached");
      this.session_registry.mark_tab_owned(agent_session_id, input.tab_id);
      this.active_tab_by_session.set(agent_session_id, input.tab_id);
      await this.publish_connections_snapshot("attach_to_tab");

      return {
        tab_id: input.tab_id,
        attached: true,
        owner_agent_session_id: lock.owner_agent_session_id,
        debugger_attached: true,
        owned_by_current_session: true,
        recommended_next_tools: ["browser_snapshot", "browser_lookup", "browser_navigate", "browser_interact"],
      };
    } catch (error) {
      const current_lock = this.tab_lock_manager.get_lock(input.tab_id);
      if (!this.session_registry.has_session(agent_session_id) && current_lock?.owner_agent_session_id === agent_session_id) {
        try {
          await this.bridge_transport.detach_from_tab(input.tab_id, agent_session_id);
        } catch {
          // best-effort cleanup if the session closed during attach
        }
      }

      try {
        this.tab_lock_manager.release_lock(input.tab_id, agent_session_id);
      } catch {
        // ignore cleanup failure
      }

      const mapped_error = to_tool_error(error);

      if (mapped_error.code === "ATTACH_FAILED" || mapped_error.code === "SESSION_NOT_FOUND") {
        throw mapped_error;
      }

      throw new tool_error("ATTACH_FAILED", mapped_error.message, mapped_error.retryable, mapped_error.details);
    }
  }

  private async detach_from_tab(
    agent_session_id: string,
    input: detach_from_tab_input,
  ): Promise<{
    tab_id: number;
    detached: boolean;
    debugger_attached: boolean;
    owned_by_current_session: boolean;
    recommended_next_tools: string[];
  }> {
    const active_lock = this.tab_lock_manager.get_lock(input.tab_id);

    if (!active_lock) {
      let state_changed = false;

      try {
        this.session_registry.mark_tab_released(agent_session_id, input.tab_id);
        state_changed = true;
      } catch {
        // session may not currently own the tab
      }

      const active_tab_id = this.active_tab_by_session.get(agent_session_id);
      if (active_tab_id === input.tab_id) {
        this.active_tab_by_session.delete(agent_session_id);
        state_changed = true;
      }

      if (state_changed) {
        await this.publish_connections_snapshot("detach_from_tab");
      }

      return {
        tab_id: input.tab_id,
        detached: true,
        debugger_attached: false,
        owned_by_current_session: false,
        recommended_next_tools: ["list_available_tabs", "attach_to_tab", "browser_tabs"],
      };
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
      debugger_attached: false,
      owned_by_current_session: false,
      recommended_next_tools: ["list_available_tabs", "attach_to_tab", "browser_tabs"],
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

  private assert_session_is_active(agent_session_id: string): void {
    if (this.session_registry.has_session(agent_session_id)) {
      return;
    }

    throw new tool_error("SESSION_NOT_FOUND", `unknown session: ${agent_session_id}`, false, {
      agent_session_id,
    });
  }

  private parse_detach_args(agent_session_id: string, args: Record<string, unknown>): detach_from_tab_input {
    const tab_id = args.tab_id;

    if (typeof tab_id === "number" && Number.isInteger(tab_id) && tab_id > 0) {
      return { tab_id };
    }

    if (typeof tab_id !== "undefined") {
      throw new tool_error(
        "INVALID_ARGUMENT",
        "tab_id must be a positive integer",
        false,
        build_invalid_argument_details({
          args,
          recovery_hint: "Pass detach_from_tab with an explicit positive integer tab_id.",
          canonical_example: {
            tab_id: 101,
          },
          expected_fields: ["tab_id"],
        }),
      );
    }

    const owned_tab_ids = [...this.session_registry.get_session(agent_session_id).owned_tab_ids].sort((left, right) => left - right);

    if (owned_tab_ids.length === 1) {
      return { tab_id: owned_tab_ids[0]! };
    }

    if (owned_tab_ids.length === 0) {
      throw new tool_error(
        "INVALID_ARGUMENT",
        "detach_from_tab requires tab_id unless the session owns exactly one tab",
        false,
        build_invalid_argument_details({
          args,
          recovery_hint: "Attach to a tab first or pass tab_id explicitly.",
          canonical_example: {
            tab_id: 101,
          },
          expected_fields: ["tab_id"],
          recommended_next_tools: ["list_available_tabs", "attach_to_tab", "browser_tabs"],
        }),
      );
    }

    throw new tool_error(
      "INVALID_ARGUMENT",
      "detach_from_tab is ambiguous because this session owns multiple tabs; pass tab_id explicitly",
      false,
      build_invalid_argument_details({
        args,
        recovery_hint: "Call list_available_tabs or browser_tabs list, choose the tab, then detach with tab_id.",
        canonical_example: {
          tab_id: owned_tab_ids[0],
        },
        expected_fields: ["tab_id"],
        owned_tab_ids,
        recommended_next_tools: ["list_available_tabs", "browser_tabs"],
      }),
    );
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

      const activate = args.activate === true;
      const stealth = args.stealth === true;

      const attach_result = await this.attach_to_tab(agent_session_id, { tab_id });

      if (stealth) {
        await this.bridge_transport.call_tool(
          "browser_tabs",
          {
            action: "set_stealth",
            tab_id,
            stealth,
          },
          agent_session_id,
        );
      }

      if (activate) {
        await this.bridge_transport.call_tool(
          "browser_tabs",
          {
            action: "activate",
            tab_id,
          },
          agent_session_id,
        );
      }

      return {
        action: "attach",
        activate,
        stealth,
        ...attach_result,
      };
    }

    if (action === "new") {
      const activate = args.activate !== false;
      const stealth = args.stealth === true;
      const create_result = (await this.bridge_transport.call_tool(
        "browser_tabs",
        {
          action: "new",
          url: typeof args.url === "string" ? args.url : "about:blank",
          activate,
          stealth,
        },
        agent_session_id,
      )) as Record<string, unknown>;

      const tab_id = create_result.tab_id;
      if (typeof tab_id !== "number") {
        throw new tool_error("ATTACH_FAILED", "extension failed to return tab_id for new tab", false, {
          create_result,
        });
      }

      const attach_result = await this.attach_to_tab(agent_session_id, { tab_id });
      return {
        action: "new",
        activate,
        stealth,
        ...attach_result,
        created_tab: create_result,
      };
    }

    if (action === "close") {
      const explicit_tab_id = args.tab_id;
      const explicit_index = args.index;
      let tab_id =
        typeof explicit_tab_id === "number" && Number.isInteger(explicit_tab_id) && explicit_tab_id > 0
          ? explicit_tab_id
          : undefined;

      if (
        typeof tab_id !== "number" &&
        typeof explicit_index === "number" &&
        Number.isInteger(explicit_index) &&
        explicit_index >= 0
      ) {
        const tabs_response = (await this.bridge_transport.call_tool(
          "browser_tabs",
          { action: "list" },
          agent_session_id,
        )) as {
          tabs?: Array<Record<string, unknown>>;
        };
        const tabs = Array.isArray(tabs_response.tabs) ? tabs_response.tabs : [];
        const matched_tab = tabs.find((tab) => tab.index === explicit_index);
        const matched_tab_id = matched_tab?.tab_id;
        if (typeof matched_tab_id !== "number") {
          throw new tool_error("TAB_NOT_FOUND", `tab index ${explicit_index} not found`, false, {
            index: explicit_index,
          });
        }
        tab_id = matched_tab_id;
      }

      if (typeof tab_id !== "number") {
        tab_id = this.active_tab_by_session.get(agent_session_id);
      }

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
          if (
            !(error instanceof tool_error) ||
            (error.code !== "LOCK_NOT_OWNED" && error.code !== "DETACH_FAILED")
          ) {
            throw error;
          }
        }
      }

      return {
        action: "close",
        tab_id,
        index: typeof explicit_index === "number" ? explicit_index : undefined,
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

    if (action === "set_cleanup_policy") {
      const stale_session_timeout_minutes = payload.stale_session_timeout_minutes;
      if (typeof stale_session_timeout_minutes !== "number") {
        return {
          ok: false,
          error: "set_cleanup_policy requires numeric stale_session_timeout_minutes",
        };
      }

      try {
        const result = this.set_stale_session_timeout_minutes(stale_session_timeout_minutes);
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

    if (action === "run_stale_session_cleanup") {
      try {
        const result = await this.run_stale_session_cleanup();
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

  private async close_session_with_reason(
    agent_session_id: string,
    reason: string,
  ): Promise<close_session_result> {
    const session = this.session_registry.get_session(agent_session_id);
    const held_lock_tab_ids = this.tab_lock_manager.list_owned_tab_ids(agent_session_id);
    const released_owned_tab_ids = [...session.owned_tab_ids];
    const cancelled_waiting_tab_ids = this.tab_lock_manager.cancel_waiters_by_owner(agent_session_id);
    const active_tab_id = this.active_tab_by_session.get(agent_session_id);

    this.active_tab_by_session.delete(agent_session_id);
    this.session_registry.close_session(agent_session_id);

    const released_tab_ids = dedupe_sorted_tab_ids([...held_lock_tab_ids, ...released_owned_tab_ids, active_tab_id]);
    for (const tab_id of released_tab_ids) {
      try {
        await this.bridge_transport.detach_from_tab(tab_id, agent_session_id);
      } catch {
        // Lock release is still required even if detach call fails.
      }

      try {
        this.tab_lock_manager.release_lock(tab_id, agent_session_id);
      } catch {
        // Lock may already be released or transferred by a detach notice.
      }
    }

    const newly_cancelled_waiting_tab_ids = this.tab_lock_manager.cancel_waiters_by_owner(agent_session_id);
    await this.publish_connections_snapshot(reason);
    return {
      released_tab_ids,
      cancelled_waiting_tab_ids: dedupe_sorted_tab_ids([
        ...cancelled_waiting_tab_ids,
        ...newly_cancelled_waiting_tab_ids,
      ]),
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
        build_invalid_argument_details({
          provided_fields: Object.keys(args).sort(),
          recovery_hint:
            "Attach to an existing tab with browser_tabs action='attach' or attach_to_tab, or create one with browser_tabs action='new'.",
          recommended_next_tools: ["browser_tabs", "attach_to_tab", "list_available_tabs"],
        }),
      );
    }

    const lock = this.tab_lock_manager.get_lock(active_tab_id);
    if (!lock || lock.owner_agent_session_id !== agent_session_id) {
      throw new tool_error("LOCK_NOT_OWNED", `session no longer owns tab ${active_tab_id}`, false, {
        active_tab_id,
        agent_session_id,
        recovery_hint: "Re-attach to the tab before retrying the browser_* tool.",
        recommended_next_tools: ["list_available_tabs", "attach_to_tab", "browser_tabs"],
      });
    }

    const normalized_args = this.normalize_tab_scoped_tool_args(tool_name, args);
    const result = await this.bridge_transport.call_tool(tool_name, normalized_args, agent_session_id, active_tab_id);

    if (result && typeof result === "object") {
      return await this.persist_artifact_if_requested(tool_name, args, result as Record<string, unknown>);
    }

    return { result };
  }

  private normalize_tab_scoped_tool_args(tool_name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (tool_name === "browser_navigate") {
      const normalized_args = { ...args };
      if (typeof normalized_args.url === "string") {
        normalized_args.url = normalized_args.url.trim();
      }

      if (typeof normalized_args.action === "undefined") {
        if (typeof normalized_args.url === "string" && normalized_args.url.length > 0) {
          normalized_args.action = "url";
          return normalized_args;
        }

        throw new tool_error(
          "INVALID_ARGUMENT",
          "browser_navigate requires action, or url to imply action='url'",
          false,
          build_invalid_argument_details({
            args,
            recovery_hint: "Pass browser_navigate with url only, or use the canonical { action: 'url', url: 'https://example.com' } shape.",
            canonical_example: {
              action: "url",
              url: "https://example.com",
            },
            expected_fields: ["action", "url"],
          }),
        );
      }

      if (normalized_args.action === "url") {
        if (typeof normalized_args.url === "string" && normalized_args.url.length > 0) {
          return normalized_args;
        }

        throw new tool_error(
          "INVALID_ARGUMENT",
          "browser_navigate action='url' requires url",
          false,
          build_invalid_argument_details({
            args,
            recovery_hint: "Pass browser_navigate with url only, or use the canonical { action: 'url', url: 'https://example.com' } shape.",
            canonical_example: {
              action: "url",
              url: "https://example.com",
            },
            expected_fields: ["action", "url"],
          }),
        );
      }

      return normalized_args;
    }

    if (tool_name === "browser_network_requests") {
      const normalized_args = { ...args };
      const canonical_request_id =
        typeof normalized_args.requestId === "string" ? normalized_args.requestId.trim() : "";
      const alias_request_id =
        typeof normalized_args.request_id === "string" ? normalized_args.request_id.trim() : "";

      if (canonical_request_id.length > 0) {
        normalized_args.requestId = canonical_request_id;
      } else if (alias_request_id.length > 0) {
        normalized_args.requestId = alias_request_id;
      }

      if (typeof normalized_args.request_id !== "undefined") {
        delete normalized_args.request_id;
      }

      const action = typeof normalized_args.action === "string" ? normalized_args.action : "list";
      if (
        (action === "details" || action === "replay") &&
        (typeof normalized_args.requestId !== "string" || normalized_args.requestId.length === 0)
      ) {
        throw new tool_error(
          "INVALID_ARGUMENT",
          `browser_network_requests action=${action} requires requestId`,
          false,
          build_invalid_argument_details({
            args,
            recovery_hint: "Call browser_network_requests action='list' first, then pass requestId or request_id from one returned row.",
            canonical_example: {
              action,
              requestId: "12345.67",
            },
            expected_fields: ["action", "requestId"],
            accepted_aliases: ["request_id"],
          }),
        );
      }

      return normalized_args;
    }

    return args;
  }

  private get_learn_browser_mcp_result(): Record<string, unknown> {
    const markdown = prompt_catalog.learn_browser_mcp.render({});
    return {
      title: "Learn Browser MCP",
      markdown,
      recommended_prompts: ["attach_and_observe", "network_debug_flow"],
      recommended_first_tools: ["browser_tabs", "attach_to_tab", "browser_snapshot", "browser_lookup"],
      common_mistakes: [
        "browser_* tools require an attached tab first.",
        "browser_tabs action='new' creates and immediately attaches a new tab for the current session.",
        "browser_navigate accepts url-only input and defaults that to action='url'.",
        "browser_network_requests uses requestId; request_id is accepted as an alias.",
        "detach_from_tab can omit tab_id only when the session owns exactly one tab.",
        "network capture only includes requests observed after attach and later navigation or reload.",
      ],
    };
  }

  private async persist_artifact_if_requested(
    tool_name: string,
    args: Record<string, unknown>,
    result: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requested_path = typeof args.path === "string" ? args.path.trim() : "";
    if (!requested_path) {
      return result;
    }

    if (tool_name !== "browser_take_screenshot" && tool_name !== "browser_pdf_save") {
      return result;
    }

    const data_base64 = typeof result.data_base64 === "string" ? result.data_base64 : "";
    if (!data_base64) {
      return result;
    }

    const absolute_path = resolve_artifact_path(requested_path);
    const bytes = Buffer.from(data_base64, "base64");

    try {
      mkdirSync(dirname(absolute_path), { recursive: true });
      const parent_real = realpathSync(dirname(absolute_path));
      if (!is_within_root(artifact_root_real, parent_real)) {
        throw new tool_error("INVALID_ARGUMENT", "artifact path must stay within the current workspace", false, {
          path: requested_path,
          artifact_root,
        });
      }

      if (existsSync(absolute_path) && lstatSync(absolute_path).isSymbolicLink()) {
        throw new tool_error("INVALID_ARGUMENT", "artifact path cannot target a symbolic link", false, {
          path: requested_path,
          artifact_root,
        });
      }

      await Bun.write(absolute_path, bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new tool_error("INVALID_ARGUMENT", `failed to persist ${tool_name} to ${absolute_path}`, false, {
        path: absolute_path,
        cause: message,
      });
    }

    const persisted_result: Record<string, unknown> = {
      ...result,
      saved: true,
      path: absolute_path,
      saved_path: absolute_path,
      bytes: bytes.byteLength,
    };

    delete persisted_result.data_base64;

    if (tool_name === "browser_pdf_save" && typeof persisted_result.mime_type !== "string") {
      persisted_result.mime_type = "application/pdf";
    }

    return persisted_result;
  }
}
