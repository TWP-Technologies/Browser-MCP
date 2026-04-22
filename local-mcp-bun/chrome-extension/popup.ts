// Modified by [KnotFalse]

import {
  count_overdue_sessions,
  compute_next_toggle_target_enabled,
  format_cleanup_chip_label,
  format_snapshot_badge_timestamp,
  is_session_overdue,
  resolve_toggle_reference_enabled,
} from "./popup_view_model";

type ui_message_payload = Record<string, unknown>;

type bridge_state = "idle" | "connecting" | "open" | "reconnecting" | string;
type bridge_ui_mode = "online" | "waiting" | "paused";

interface popup_tab {
  tab_id: number;
  index?: number;
  url: string;
  title: string;
  active?: boolean;
  window_id?: number;
  debugger_attached?: boolean;
}

interface lock_snapshot {
  tab_id: number;
  owner_agent_session_id: string;
  lock_state: string;
  lock_acquired_at: string;
}

interface session_snapshot {
  agent_session_id: string;
  client_name?: string;
  connected_at: string;
  last_seen_at: string;
  state: string;
  owned_tab_ids: number[];
}

interface connections_snapshot {
  type: "connections_snapshot";
  generated_at: string;
  sessions: session_snapshot[];
  locks: lock_snapshot[];
}

interface popup_state {
  extension_enabled: boolean;
  bridge_connection_state: bridge_state;
  next_reconnect_attempt_at_ms?: number | null;
  last_poll_attempt_at_ms?: number | null;
  poll_attempt_serial?: number;
  last_connect_failure_reason?: string | null;
  last_connect_failure_details?: string | null;
  last_connect_failure_at_ms?: number | null;
  connection_hint?: string;
  bridge_url: string;
  mcp_port: number;
  stale_session_timeout_minutes: number;
  tabs: popup_tab[];
  connections_snapshot: connections_snapshot;
}

interface ui_response<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

interface close_all_sessions_result {
  attempted_session_ids?: string[];
  closed_session_ids?: string[];
  failed?: Array<{
    agent_session_id?: string;
    error?: string;
  }>;
}

interface stale_cleanup_result {
  stale_session_timeout_minutes?: number;
  stale_session_ids?: string[];
  closed_session_ids?: string[];
  failed?: Array<{
    agent_session_id?: string;
    error?: string;
  }>;
}

const browser_api = chrome;
const app_root = document.getElementById("app");

let ui_state: popup_state | null = null;
let loading = false;
let action_in_flight = false;
let toggle_in_flight = false;
let executing_toggle_target_enabled: boolean | null = null;
let queued_toggle_target_enabled: boolean | null = null;
let error_message = "";
let info_message = "";
let refresh_in_flight = false;
let refresh_queued = false;
let pending_live_refresh = false;
let live_refresh_timer: ReturnType<typeof setTimeout> | null = null;
const live_refresh_debounce_ms = 150;
const interaction_guard_window_ms = 350;
let interaction_guard_until_ms = 0;
let interaction_guard_flush_timer: ReturnType<typeof setTimeout> | null = null;
let waiting_countdown_timer: ReturnType<typeof setInterval> | null = null;
let poll_pulse_timer: ReturnType<typeof setTimeout> | null = null;
let poll_pulse_active = false;
let last_seen_poll_attempt_serial: number | null = null;
let last_poll_pulse_started_at_ms = 0;
const poll_pulse_duration_ms = 900;
const poll_pulse_min_gap_ms = 600;
let bridge_url_copy_state: "idle" | "copied" | "failed" = "idle";
let bridge_url_copy_reset_timer: ReturnType<typeof setTimeout> | null = null;
const bridge_url_copy_feedback_timeout_ms = 1800;
let disable_modal_open = false;
let disable_modal_busy = false;
let cleanup_modal_open = false;
let cleanup_modal_enabled = true;
let cleanup_modal_minutes_input = "120";
let cleanup_modal_busy_action: "save" | "run" | null = null;

function escape_html(input: unknown): string {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function format_timestamp(iso_timestamp: string | undefined): string {
  if (typeof iso_timestamp !== "string" || iso_timestamp.length === 0) {
    return "-";
  }

  const parsed = new Date(iso_timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }

  return parsed.toLocaleString();
}

function clear_messages(): void {
  error_message = "";
  info_message = "";
}

function set_error_banner(message: string): void {
  error_message = message;
  info_message = "";
}

function set_info_banner(message: string): void {
  info_message = message;
  error_message = "";
}

function resolve_cleanup_timeout_minutes(): number {
  const timeout_minutes = ui_state?.stale_session_timeout_minutes;
  if (typeof timeout_minutes === "number" && Number.isInteger(timeout_minutes) && timeout_minutes >= 0) {
    return timeout_minutes;
  }

  return 120;
}

function resolve_bridge_ui_mode(extension_enabled: boolean, state: bridge_state): bridge_ui_mode {
  if (!extension_enabled) {
    return "paused";
  }

  if (state === "open") {
    return "online";
  }

  return "waiting";
}

function describe_bridge_state(mode: bridge_ui_mode): string {
  if (mode === "online") {
    return "Online";
  }

  if (mode === "paused") {
    return "Paused";
  }

  return "Waiting for connection";
}

function bridge_state_class(mode: bridge_ui_mode): string {
  if (mode === "online") {
    return "chip--state-online";
  }

  if (mode === "waiting") {
    return "chip--state-pending";
  }

  return "chip--state-offline";
}

function describe_poll_schedule(next_reconnect_attempt_at_ms: number | null | undefined): string {
  if (typeof next_reconnect_attempt_at_ms !== "number") {
    return "Polling now...";
  }

  const remaining_seconds = Math.max(0, Math.ceil((next_reconnect_attempt_at_ms - Date.now()) / 1000));
  if (remaining_seconds <= 0) {
    return "Polling now...";
  }

  return `Polling in ${remaining_seconds}s`;
}

function resolve_waiting_hint(state: popup_state | null, mode: bridge_ui_mode): string {
  if (!state || mode !== "waiting") {
    return "";
  }

  const explicit_hint = typeof state.connection_hint === "string" ? state.connection_hint.trim() : "";
  if (explicit_hint.length > 0) {
    return explicit_hint;
  }

  return `Waiting for MCP bridge on port ${state.mcp_port}.`;
}

function is_interaction_guard_active(): boolean {
  return Date.now() < interaction_guard_until_ms;
}

function flush_pending_live_refresh_if_ready(): void {
  if (!pending_live_refresh) {
    return;
  }

  if (action_in_flight || toggle_in_flight || is_interaction_guard_active()) {
    return;
  }

  pending_live_refresh = false;
  void refresh_state(false, false);
}

function schedule_interaction_guard_flush(): void {
  if (interaction_guard_flush_timer !== null) {
    globalThis.clearTimeout(interaction_guard_flush_timer);
  }

  const delay_ms = Math.max(0, interaction_guard_until_ms - Date.now()) + 24;
  interaction_guard_flush_timer = globalThis.setTimeout(() => {
    interaction_guard_flush_timer = null;
    flush_pending_live_refresh_if_ready();
  }, delay_ms);
}

function mark_ui_interaction_guard(): void {
  interaction_guard_until_ms = Date.now() + interaction_guard_window_ms;
  schedule_interaction_guard_flush();
}

function stop_waiting_countdown_timer(): void {
  if (waiting_countdown_timer === null) {
    return;
  }

  globalThis.clearInterval(waiting_countdown_timer);
  waiting_countdown_timer = null;
}

function sync_poll_indicator_dom(): void {
  const indicator = document.getElementById("poll-indicator");
  if (!(indicator instanceof HTMLElement)) {
    return;
  }

  indicator.classList.toggle("poll-indicator--pulse", poll_pulse_active);
}

function update_poll_status_label_dom(): void {
  const poll_status_label = document.getElementById("poll-status-label");
  if (!(poll_status_label instanceof HTMLElement)) {
    return;
  }

  const mode = resolve_bridge_ui_mode(ui_state?.extension_enabled === true, ui_state?.bridge_connection_state ?? "idle");
  if (mode !== "waiting") {
    poll_status_label.textContent = "";
    return;
  }

  poll_status_label.textContent = describe_poll_schedule(ui_state?.next_reconnect_attempt_at_ms);
}

function sync_waiting_countdown_timer(): void {
  const mode = resolve_bridge_ui_mode(ui_state?.extension_enabled === true, ui_state?.bridge_connection_state ?? "idle");
  const has_due_time = typeof ui_state?.next_reconnect_attempt_at_ms === "number";

  if (mode === "waiting" && has_due_time) {
    if (waiting_countdown_timer === null) {
      waiting_countdown_timer = globalThis.setInterval(() => {
        update_poll_status_label_dom();
      }, 1000);
    }
    return;
  }

  stop_waiting_countdown_timer();
}

function sync_waiting_ui_effects(): void {
  update_poll_status_label_dom();
  sync_poll_indicator_dom();
  sync_waiting_countdown_timer();
}

function resolve_bridge_url_copy_status_label(): string {
  if (bridge_url_copy_state === "copied") {
    return "Copied full URL";
  }

  if (bridge_url_copy_state === "failed") {
    return "Clipboard unavailable";
  }

  return "";
}

function resolve_bridge_url_copy_button_label(): string {
  return bridge_url_copy_state === "copied" ? "Copied" : "Copy";
}

function sync_bridge_url_copy_dom(): void {
  const copy_button = document.querySelector('[data-testid="copy-bridge-url-btn"]');
  if (copy_button instanceof HTMLButtonElement) {
    copy_button.textContent = resolve_bridge_url_copy_button_label();
  }

  const copy_status = document.querySelector('[data-testid="bridge-url-copy-status"]');
  if (copy_status instanceof HTMLElement) {
    copy_status.textContent = resolve_bridge_url_copy_status_label();
    copy_status.classList.toggle("meta-copy-status--visible", bridge_url_copy_state !== "idle");
  }
}

function clear_bridge_url_copy_reset_timer(): void {
  if (bridge_url_copy_reset_timer === null) {
    return;
  }

  globalThis.clearTimeout(bridge_url_copy_reset_timer);
  bridge_url_copy_reset_timer = null;
}

function set_bridge_url_copy_state(next_state: "idle" | "copied" | "failed"): void {
  bridge_url_copy_state = next_state;
  clear_bridge_url_copy_reset_timer();

  if (next_state !== "idle") {
    bridge_url_copy_reset_timer = globalThis.setTimeout(() => {
      bridge_url_copy_reset_timer = null;
      bridge_url_copy_state = "idle";
      sync_bridge_url_copy_dom();
    }, bridge_url_copy_feedback_timeout_ms);
  }

  sync_bridge_url_copy_dom();
}

function fallback_copy_text_to_clipboard(value: string): boolean {
  try {
    const text_area = document.createElement("textarea");
    text_area.value = value;
    text_area.setAttribute("readonly", "true");
    text_area.style.position = "fixed";
    text_area.style.top = "-10000px";
    text_area.style.opacity = "0";
    document.body.appendChild(text_area);
    text_area.focus();
    text_area.select();
    text_area.setSelectionRange(0, text_area.value.length);
    const copied = document.execCommand("copy");
    text_area.remove();
    return copied;
  } catch {
    return false;
  }
}

async function write_text_to_clipboard(value: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === "function") {
    await navigator.clipboard.writeText(value);
    return;
  }

  const copied = fallback_copy_text_to_clipboard(value);
  if (!copied) {
    throw new Error("clipboard write failed");
  }
}

async function copy_bridge_url(): Promise<void> {
  const bridge_url = ui_state?.bridge_url?.trim();
  if (!bridge_url) {
    set_bridge_url_copy_state("failed");
    return;
  }

  try {
    await write_text_to_clipboard(bridge_url);
    set_bridge_url_copy_state("copied");
  } catch {
    set_bridge_url_copy_state("failed");
  }
}

function trigger_poll_pulse(): void {
  const now_ms = Date.now();
  if (now_ms - last_poll_pulse_started_at_ms < poll_pulse_min_gap_ms) {
    return;
  }

  last_poll_pulse_started_at_ms = now_ms;
  poll_pulse_active = true;
  sync_poll_indicator_dom();

  if (poll_pulse_timer !== null) {
    globalThis.clearTimeout(poll_pulse_timer);
  }

  poll_pulse_timer = globalThis.setTimeout(() => {
    poll_pulse_active = false;
    poll_pulse_timer = null;
    sync_poll_indicator_dom();
  }, poll_pulse_duration_ms);
}

function maybe_trigger_poll_pulse(next_state: popup_state | null): void {
  const current_serial = next_state?.poll_attempt_serial;
  if (typeof current_serial !== "number") {
    return;
  }

  if (last_seen_poll_attempt_serial !== null && current_serial > last_seen_poll_attempt_serial) {
    trigger_poll_pulse();
  }

  last_seen_poll_attempt_serial = current_serial;
}

async function send_ui_message<T>(type: string, payload: ui_message_payload = {}): Promise<T> {
  const response = (await browser_api.runtime.sendMessage({
    type,
    ...payload,
  })) as ui_response<T> | undefined;

  if (!response || response.ok !== true) {
    throw new Error(typeof response?.error === "string" ? response.error : `request failed: ${type}`);
  }

  if (typeof response.result === "undefined") {
    throw new Error(`request returned no result: ${type}`);
  }

  return response.result;
}

async function refresh_state(clear_error = true, show_loading = true): Promise<void> {
  if (refresh_in_flight) {
    refresh_queued = true;
    return;
  }

  refresh_in_flight = true;

  if (clear_error) {
    clear_messages();
  }

  if (show_loading) {
    loading = true;
    render();
  }

  try {
    ui_state = await send_ui_message<popup_state>("ui_get_state");
    maybe_trigger_poll_pulse(ui_state);
  } catch (error) {
    set_error_banner(error instanceof Error ? error.message : String(error));
  } finally {
    if (show_loading) {
      loading = false;
    }

    refresh_in_flight = false;
    render();

    if (refresh_queued) {
      refresh_queued = false;
      await refresh_state(false, false);
    }
  }
}

async function run_action(callback: () => Promise<void>): Promise<void> {
  if (action_in_flight || toggle_in_flight) {
    return;
  }

  action_in_flight = true;
  render();

  try {
    await callback();
    await refresh_state();
  } catch (error) {
    set_error_banner(error instanceof Error ? error.message : String(error));
    render();
  } finally {
    action_in_flight = false;
    render();
    flush_pending_live_refresh_if_ready();
  }
}

function get_active_session_count(): number {
  const sessions = ui_state?.connections_snapshot?.sessions;
  if (!Array.isArray(sessions)) {
    return 0;
  }

  return sessions.filter((session) => typeof session?.agent_session_id === "string").length;
}

function set_disable_modal_state(open: boolean, busy = false): void {
  disable_modal_open = open;
  disable_modal_busy = busy;
  render();
}

function summarize_close_all_failures(payload: close_all_sessions_result): string {
  const failed_rows = Array.isArray(payload.failed) ? payload.failed : [];
  if (failed_rows.length === 0) {
    return "";
  }

  const failed_summary = failed_rows
    .map((entry) => {
      const agent_session_id = typeof entry.agent_session_id === "string" ? entry.agent_session_id : "unknown-session";
      const message = typeof entry.error === "string" && entry.error.length > 0 ? entry.error : "unknown failure";
      return `${agent_session_id}: ${message}`;
    })
    .join("; ");

  return `Disabled connections with close-session failures: ${failed_summary}`;
}

async function apply_extension_enabled(target_enabled: boolean): Promise<void> {
  await send_ui_message<popup_state>("ui_set_enabled", {
    enabled: target_enabled,
  });
  await refresh_state(false, false);
}

async function run_disable_with_close_all_sessions(): Promise<void> {
  if (toggle_in_flight || action_in_flight) {
    return;
  }

  toggle_in_flight = true;
  disable_modal_busy = true;
  render();

  let close_all_failure_summary = "";

  try {
    try {
      const close_all_result = await send_ui_message<close_all_sessions_result>("ui_close_all_sessions");
      close_all_failure_summary = summarize_close_all_failures(close_all_result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      close_all_failure_summary = `Failed to close all sessions before disable: ${message}`;
    }

    await apply_extension_enabled(false);
    if (close_all_failure_summary.length > 0) {
      set_error_banner(close_all_failure_summary);
    }
  } catch (error) {
    const disable_message = error instanceof Error ? error.message : String(error);
    if (close_all_failure_summary.length > 0) {
      set_error_banner(`${close_all_failure_summary} Disable failed: ${disable_message}`);
    } else {
      set_error_banner(disable_message);
    }
  } finally {
    disable_modal_open = false;
    disable_modal_busy = false;
    queued_toggle_target_enabled = null;
    executing_toggle_target_enabled = null;
    toggle_in_flight = false;
    render();
    flush_pending_live_refresh_if_ready();
  }
}

function resolve_toggle_next_target_enabled(): boolean {
  return compute_next_toggle_target_enabled({
    extension_enabled: ui_state?.extension_enabled === true,
    executing_target_enabled: executing_toggle_target_enabled,
    queued_target_enabled: queued_toggle_target_enabled,
  });
}

function queue_toggle_target_enabled(target_enabled: boolean): void {
  queued_toggle_target_enabled = target_enabled;

  if (toggle_in_flight) {
    render();
    return;
  }

  void drain_toggle_queue();
}

async function drain_toggle_queue(): Promise<void> {
  if (toggle_in_flight || queued_toggle_target_enabled === null) {
    return;
  }

  toggle_in_flight = true;
  globalThis.queueMicrotask(() => {
    if (toggle_in_flight) {
      render();
    }
  });

  try {
    while (queued_toggle_target_enabled !== null) {
      const target_enabled = queued_toggle_target_enabled;
      queued_toggle_target_enabled = null;
      executing_toggle_target_enabled = target_enabled;

      if ((ui_state?.extension_enabled === true) === target_enabled) {
        executing_toggle_target_enabled = null;
        continue;
      }

      await apply_extension_enabled(target_enabled);

      executing_toggle_target_enabled = null;
    }
  } catch (error) {
    executing_toggle_target_enabled = null;
    queued_toggle_target_enabled = null;
    set_error_banner(error instanceof Error ? error.message : String(error));
    render();
  } finally {
    toggle_in_flight = false;
    render();
    flush_pending_live_refresh_if_ready();
  }
}

function set_cleanup_modal_state(open: boolean): void {
  if (open) {
    const timeout_minutes = resolve_cleanup_timeout_minutes();
    cleanup_modal_enabled = timeout_minutes > 0;
    cleanup_modal_minutes_input = String(timeout_minutes > 0 ? timeout_minutes : 120);
    cleanup_modal_busy_action = null;
    cleanup_modal_open = true;
    render();
    return;
  }

  cleanup_modal_open = false;
  cleanup_modal_busy_action = null;
  render();
}

function parse_cleanup_minutes_input(): number {
  const parsed_timeout_minutes = Number.parseInt(cleanup_modal_minutes_input, 10);
  if (!Number.isInteger(parsed_timeout_minutes) || parsed_timeout_minutes < 1 || parsed_timeout_minutes > 10_080) {
    throw new Error("Cleanup minutes must be an integer between 1 and 10080");
  }

  return parsed_timeout_minutes;
}

function summarize_stale_cleanup_result(payload: stale_cleanup_result): { info_message?: string; error_message?: string } {
  const failed_rows = Array.isArray(payload.failed) ? payload.failed : [];
  const closed_count = Array.isArray(payload.closed_session_ids) ? payload.closed_session_ids.length : 0;

  if (failed_rows.length > 0) {
    const failed_summary = failed_rows
      .map((entry) => {
        const agent_session_id = typeof entry.agent_session_id === "string" ? entry.agent_session_id : "unknown-session";
        const message = typeof entry.error === "string" && entry.error.length > 0 ? entry.error : "unknown failure";
        return `${agent_session_id}: ${message}`;
      })
      .join("; ");

    return {
      error_message: `Cleanup completed with failures${closed_count > 0 ? ` after closing ${closed_count} session${closed_count === 1 ? "" : "s"}` : ""}: ${failed_summary}`,
    };
  }

  if (closed_count > 0) {
    return {
      info_message: `Closed ${closed_count} stale session${closed_count === 1 ? "" : "s"}.`,
    };
  }

  return {
    info_message: "No stale sessions were eligible for cleanup.",
  };
}

async function run_cleanup_modal_save(): Promise<void> {
  if (action_in_flight || toggle_in_flight || cleanup_modal_busy_action !== null) {
    return;
  }

  cleanup_modal_busy_action = "save";
  render();

  try {
    const timeout_minutes = cleanup_modal_enabled ? parse_cleanup_minutes_input() : 0;
    await send_ui_message<popup_state>("ui_set_cleanup_policy", {
      stale_session_timeout_minutes: timeout_minutes,
    });
    set_info_banner(
      timeout_minutes > 0
        ? `Auto-cleanup set to ${timeout_minutes} minute${timeout_minutes === 1 ? "" : "s"}.`
        : "Auto-cleanup disabled.",
    );
    cleanup_modal_open = false;
    await refresh_state(false, false);
  } catch (error) {
    set_error_banner(error instanceof Error ? error.message : String(error));
  } finally {
    cleanup_modal_busy_action = null;
    render();
    flush_pending_live_refresh_if_ready();
  }
}

async function run_cleanup_now(): Promise<void> {
  if (action_in_flight || toggle_in_flight || cleanup_modal_busy_action !== null) {
    return;
  }

  cleanup_modal_busy_action = "run";
  render();

  try {
    const result = await send_ui_message<stale_cleanup_result>("ui_run_stale_cleanup");
    const cleanup_summary = summarize_stale_cleanup_result(result);
    if (cleanup_summary.error_message) {
      set_error_banner(cleanup_summary.error_message);
    } else if (cleanup_summary.info_message) {
      set_info_banner(cleanup_summary.info_message);
    }

    cleanup_modal_open = false;
    await refresh_state(false, false);
  } catch (error) {
    set_error_banner(error instanceof Error ? error.message : String(error));
  } finally {
    cleanup_modal_busy_action = null;
    render();
    flush_pending_live_refresh_if_ready();
  }
}

function request_live_refresh(): void {
  if (action_in_flight || toggle_in_flight || is_interaction_guard_active()) {
    pending_live_refresh = true;
    return;
  }

  if (live_refresh_timer !== null) {
    return;
  }

  live_refresh_timer = globalThis.setTimeout(() => {
    live_refresh_timer = null;
    if (action_in_flight || toggle_in_flight || is_interaction_guard_active()) {
      pending_live_refresh = true;
      schedule_interaction_guard_flush();
      return;
    }

    void refresh_state(false, false);
  }, live_refresh_debounce_ms);
}

function read_port_input_value(): number {
  const port_input = document.getElementById("port-input");
  if (!(port_input instanceof HTMLInputElement)) {
    throw new Error("port input not available");
  }

  const parsed_port = Number.parseInt(port_input.value, 10);
  if (!Number.isInteger(parsed_port) || parsed_port < 1 || parsed_port > 65_535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }

  return parsed_port;
}

function render_locked_rows(locks: lock_snapshot[], tab_by_id: Map<number, popup_tab>, disable_all: boolean): string {
  if (locks.length === 0) {
    return '<p class="empty-state">No locked tabs. Attach a tab from an agent session to see lock ownership.</p>';
  }

  return `<div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Agent Session</th>
            <th>Tab</th>
            <th>Lock</th>
            <th class="actions-cell">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${locks
      .map((lock) => {
        const tab = tab_by_id.get(lock.tab_id);
        const tab_title = tab?.title || "(tab unavailable)";
        const tab_url = tab?.url || "";

        return `<tr>
                <td>
                  <code class="code-id">${escape_html(lock.owner_agent_session_id)}</code>
                </td>
                <td>
                  <div class="tab-title">#${lock.tab_id} ${escape_html(tab_title)}</div>
                  <div class="tab-url">${escape_html(tab_url)}</div>
                </td>
                <td>
                  <span class="chip chip--compact chip--state-pending">${escape_html(lock.lock_state || "attached")}</span>
                </td>
                <td class="actions-cell">
                  <div class="inline-actions">
                    <button class="btn btn--ghost" data-action="goto-tab" data-tab-id="${lock.tab_id}" ${disable_all ? "disabled" : ""}>Go to tab</button>
                    <button class="btn btn--danger" data-action="detach-tab" data-tab-id="${lock.tab_id}" ${disable_all ? "disabled" : ""}>Detach</button>
                  </div>
                </td>
              </tr>`;
      })
      .join("")}
        </tbody>
      </table>
    </div>`;
}

function render_session_rows(
  sessions: session_snapshot[],
  disable_all: boolean,
  stale_session_timeout_minutes: number,
): string {
  if (sessions.length === 0) {
    return '<p class="empty-state">No active sessions. Agent connections will appear here once connected.</p>';
  }

  return `<div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Agent Session</th>
            <th>State</th>
            <th>Owned Tabs</th>
            <th>Last Seen</th>
            <th class="actions-cell">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${sessions
      .map((session) => {
        const client_name = session.client_name && session.client_name.length > 0 ? session.client_name : "-";
        const owned_tabs = session.owned_tab_ids.length > 0 ? session.owned_tab_ids.join(", ") : "-";
        const overdue = is_session_overdue(session, stale_session_timeout_minutes);
        const state_chip_class =
          session.state === "connected" ? "chip--state-online" : session.state === "disconnecting" ? "chip--state-pending" : "chip--state-offline";

        return `<tr>
                <td>
                  <code class="code-id">${escape_html(session.agent_session_id)}</code>
                  <div class="meta-line">client: ${escape_html(client_name)}</div>
                </td>
                <td>
                  <div class="session-state-cell">
                    <span class="chip chip--compact ${state_chip_class}">${escape_html(session.state || "connected")}</span>
                    ${overdue ? '<span class="chip chip--compact chip--state-pending">overdue</span>' : ""}
                  </div>
                </td>
                <td>${escape_html(owned_tabs)}</td>
                <td>${escape_html(format_timestamp(session.last_seen_at))}</td>
                <td class="actions-cell">
                  <button class="btn btn--danger" data-action="close-session" data-agent-session-id="${escape_html(session.agent_session_id)}" ${disable_all ? "disabled" : ""}>Close session</button>
                </td>
              </tr>`;
      })
      .join("")}
        </tbody>
      </table>
    </div>`;
}

function render(): void {
  if (!app_root) {
    return;
  }

  const extension_enabled = ui_state?.extension_enabled === true;
  const bridge_connection_state: bridge_state = ui_state?.bridge_connection_state ?? "idle";
  const bridge_mode = resolve_bridge_ui_mode(extension_enabled, bridge_connection_state);
  const bridge_url = ui_state?.bridge_url ?? "ws://127.0.0.1:37777/extension";
  const mcp_port = ui_state?.mcp_port ?? 37_777;
  const stale_session_timeout_minutes = resolve_cleanup_timeout_minutes();

  const tabs = Array.isArray(ui_state?.tabs) ? ui_state.tabs : [];
  const sessions = Array.isArray(ui_state?.connections_snapshot?.sessions) ? ui_state.connections_snapshot.sessions : [];
  const locks = Array.isArray(ui_state?.connections_snapshot?.locks) ? ui_state.connections_snapshot.locks : [];
  const generated_at = ui_state?.connections_snapshot?.generated_at;

  const tab_by_id = new Map<number, popup_tab>();
  for (const tab of tabs) {
    if (typeof tab.tab_id === "number") {
      tab_by_id.set(tab.tab_id, tab);
    }
  }

  const sorted_locks = locks
    .filter((lock) => typeof lock.tab_id === "number" && typeof lock.owner_agent_session_id === "string")
    .sort((left, right) => left.tab_id - right.tab_id);

  const sorted_sessions = sessions
    .filter((session) => typeof session.agent_session_id === "string")
    .sort((left, right) => left.agent_session_id.localeCompare(right.agent_session_id));
  const active_session_count = sorted_sessions.length;
  const overdue_session_count = count_overdue_sessions(sorted_sessions, stale_session_timeout_minutes);

  const disable_non_toggle_actions =
    loading || action_in_flight || toggle_in_flight || disable_modal_busy || cleanup_modal_busy_action !== null;
  const disable_toggle_action = loading || action_in_flight;
  const toggle_reference_enabled = resolve_toggle_reference_enabled({
    extension_enabled,
    executing_target_enabled: executing_toggle_target_enabled,
    queued_target_enabled: queued_toggle_target_enabled,
  });
  const toggle_button_label = toggle_reference_enabled ? "Disable Connections" : "Enable Connections";
  const toggle_button_class = toggle_reference_enabled ? "btn--danger" : "btn--primary";
  const bridge_state_label = describe_bridge_state(bridge_mode);
  const waiting_poll_label = describe_poll_schedule(ui_state?.next_reconnect_attempt_at_ms);
  const waiting_hint_label = resolve_waiting_hint(ui_state, bridge_mode);
  const bridge_url_copy_button_label = resolve_bridge_url_copy_button_label();
  const bridge_url_copy_status_label = resolve_bridge_url_copy_status_label();
  const cleanup_chip_label = format_cleanup_chip_label(stale_session_timeout_minutes);
  const cleanup_chip_suffix = overdue_session_count > 0 ? ` · ${overdue_session_count} overdue` : "";
  const cleanup_chip_class =
    overdue_session_count > 0
      ? "chip--state-pending"
      : stale_session_timeout_minutes > 0
        ? "chip--muted"
        : "chip--state-offline";

  app_root.innerHTML = `
    <div class="surface">
      ${error_message
      ? `<div class="error-banner" role="alert">
              <span class="error-banner__glyph">!</span>
              <span>${escape_html(error_message)}</span>
            </div>`
      : ""
    }
      ${!error_message && info_message
      ? `<div class="error-banner error-banner--info" role="status">
              <span class="error-banner__glyph error-banner__glyph--info">i</span>
              <span>${escape_html(info_message)}</span>
            </div>`
      : ""
    }

      <section class="panel panel--command">
        <header class="command-header">
          <div class="command-title">
            <p class="eyebrow">Local-first Browser Relay</p>
            <h1>Browser Use for Agents</h1>
          </div>
          <div class="command-actions">
            <button class="btn btn--ghost" data-action="refresh" ${disable_non_toggle_actions ? "disabled" : ""}>Refresh</button>
            <button
              class="btn ${toggle_button_class}"
              data-action="toggle-enabled"
              data-testid="toggle-enabled-btn"
              ${disable_toggle_action ? "disabled" : ""}
            >
              ${toggle_button_label}
            </button>
          </div>
        </header>

        <div class="status-strip">
          <span class="chip ${bridge_state_class(bridge_mode)}">Bridge ${escape_html(bridge_state_label)}</span>
          <span class="chip ${extension_enabled ? "chip--enabled" : "chip--disabled"}">
            ${extension_enabled ? "Connections enabled" : "Connections paused"}
          </span>
          <button
            class="chip chip--button ${cleanup_chip_class}"
            data-action="open-cleanup-modal"
            data-testid="cleanup-chip"
            ${disable_non_toggle_actions ? "disabled" : ""}
          >
            ${escape_html(`${cleanup_chip_label}${cleanup_chip_suffix}`)}
          </button>
          <div
            class="poll-meta ${bridge_mode === "waiting" ? "" : "poll-meta--hidden"}"
            id="bridge-waiting-meta"
            data-testid="poll-chip"
          >
            <span class="poll-indicator ${poll_pulse_active ? "poll-indicator--pulse" : ""}" id="poll-indicator" aria-hidden="true"></span>
            <span id="poll-status-label">${escape_html(waiting_poll_label)}</span>
          </div>
          <span class="chip chip--muted chip--snapshot" data-testid="snapshot-chip">
            Snapshot ${escape_html(format_snapshot_badge_timestamp(generated_at))}
          </span>
        </div>
        <p
          class="bridge-hint ${bridge_mode === "waiting" && waiting_hint_label.length > 0 ? "" : "bridge-hint--hidden"}"
          data-testid="bridge-hint"
        >${escape_html(waiting_hint_label)}</p>

        <dl class="meta-strip">
          <div class="meta-item meta-item--url">
            <div class="meta-item__header">
              <dt>URL</dt>
              <button
                class="btn btn--ghost btn--tiny"
                data-action="copy-bridge-url"
                data-testid="copy-bridge-url-btn"
                ${disable_non_toggle_actions ? "disabled" : ""}
              >
                ${escape_html(bridge_url_copy_button_label)}
              </button>
            </div>
            <dd>
              <button
                class="url-copy-surface"
                type="button"
                data-action="copy-bridge-url"
                data-testid="bridge-url-copy-surface"
                title="Copy full bridge URL"
                ${disable_non_toggle_actions ? "disabled" : ""}
              >
                <code data-testid="bridge-url-text">${escape_html(bridge_url)}</code>
              </button>
              <span
                class="meta-copy-status ${bridge_url_copy_state === "idle" ? "" : "meta-copy-status--visible"}"
                data-testid="bridge-url-copy-status"
              >${escape_html(bridge_url_copy_status_label)}</span>
            </dd>
          </div>
          <div class="meta-item">
            <dt>Locks</dt>
            <dd>${sorted_locks.length}</dd>
          </div>
          <div class="meta-item">
            <dt>Sessions</dt>
            <dd>${sorted_sessions.length}</dd>
          </div>
        </dl>
      </section>

      <section class="panel panel--port">
        <header class="panel__subhead">
          <h2>Bridge Port</h2>
          <p>Change the MCP bridge port. Saving reconnects immediately when enabled.</p>
        </header>
        <div class="port-row">
          <label for="port-input">MCP Port</label>
          <input
            id="port-input"
            type="number"
            min="1"
            max="65535"
            value="${mcp_port}"
            ${disable_non_toggle_actions ? "disabled" : ""}
          />
          <button class="btn btn--primary" data-action="save-port" ${disable_non_toggle_actions ? "disabled" : ""}>
            Apply Port
          </button>
        </div>
      </section>

      <section class="panel panel--data">
        <header class="panel__subhead">
          <h2>Locked Tabs</h2>
          <p>Tab ownership and debugger lock state across connected agent sessions.</p>
        </header>
        ${render_locked_rows(sorted_locks, tab_by_id, disable_non_toggle_actions)}
      </section>

      <section class="panel panel--data">
        <header class="panel__subhead">
          <h2>Active Sessions</h2>
          <p>Session lifecycle state with direct termination controls.</p>
        </header>
        ${render_session_rows(sorted_sessions, disable_non_toggle_actions, stale_session_timeout_minutes)}
      </section>
      <div class="modal-backdrop ${cleanup_modal_open ? "" : "modal-backdrop--hidden"}" data-testid="cleanup-modal-backdrop">
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="cleanup-modal-title">
          <h3 id="cleanup-modal-title">Session Auto-cleanup</h3>
          <p>Hard-reaps stale sessions, detaches owned tabs, cancels queued locks, and closes stale proxy connections.</p>
          <label class="modal-field modal-field--toggle" for="cleanup-enabled-input">
            <span>Enable auto-close</span>
            <input
              id="cleanup-enabled-input"
              type="checkbox"
              ${cleanup_modal_enabled ? "checked" : ""}
              ${cleanup_modal_busy_action !== null ? "disabled" : ""}
            />
          </label>
          <label class="modal-field" for="cleanup-minutes-input">
            <span>After minutes</span>
            <input
              id="cleanup-minutes-input"
              type="number"
              min="1"
              max="10080"
              step="1"
              value="${escape_html(cleanup_modal_minutes_input)}"
              ${!cleanup_modal_enabled || cleanup_modal_busy_action !== null ? "disabled" : ""}
            />
          </label>
          <div class="modal-actions">
            <button class="btn btn--ghost" data-action="cleanup-modal-cancel" ${cleanup_modal_busy_action !== null ? "disabled" : ""}>Cancel</button>
            <button class="btn btn--ghost" data-action="cleanup-modal-run-now" ${cleanup_modal_busy_action !== null ? "disabled" : ""}>
              ${cleanup_modal_busy_action === "run" ? "Cleaning..." : "Run Cleanup Now"}
            </button>
            <button class="btn btn--primary" data-action="cleanup-modal-save" ${cleanup_modal_busy_action !== null ? "disabled" : ""}>
              ${cleanup_modal_busy_action === "save" ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
      <div class="modal-backdrop ${disable_modal_open ? "" : "modal-backdrop--hidden"}" data-testid="disable-modal-backdrop">
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="disable-modal-title">
          <h3 id="disable-modal-title">Disable Agent Connections?</h3>
          <p>
            ${escape_html(
              `You have ${active_session_count} active session${active_session_count === 1 ? "" : "s"}. You can disable only, or close all sessions first and then disable.`,
            )}
          </p>
          <div class="modal-actions">
            <button class="btn btn--ghost" data-action="disable-modal-cancel" ${disable_modal_busy ? "disabled" : ""}>Cancel</button>
            <button class="btn btn--danger" data-action="disable-modal-disable-only" ${disable_modal_busy ? "disabled" : ""}>Disable Only</button>
            <button class="btn btn--primary" data-action="disable-modal-close-all" ${disable_modal_busy ? "disabled" : ""}>
              ${disable_modal_busy ? "Closing Sessions..." : "Close All + Disable"}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  sync_waiting_ui_effects();
  sync_bridge_url_copy_dom();
}

function register_event_listeners(): void {
  if (!app_root) {
    return;
  }

  app_root.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button[data-action]");
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      mark_ui_interaction_guard();
    },
    true,
  );

  app_root.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (!(event instanceof KeyboardEvent)) {
        return;
      }

      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      const button = target.closest("button[data-action]");
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      mark_ui_interaction_guard();
    },
    true,
  );

  app_root.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target instanceof HTMLInputElement && target.id === "cleanup-enabled-input") {
      cleanup_modal_enabled = target.checked;
      render();
      return;
    }

    if (target instanceof HTMLInputElement && target.id === "cleanup-minutes-input") {
      cleanup_modal_minutes_input = target.value;
    }
  });

  app_root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest("button[data-action]");
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const action = button.dataset.action;
    if (!action) {
      return;
    }

    mark_ui_interaction_guard();

    if (action === "refresh") {
      void refresh_state();
      return;
    }

    if (action === "open-cleanup-modal") {
      set_cleanup_modal_state(true);
      return;
    }

    if (action === "toggle-enabled") {
      const next_target_enabled = resolve_toggle_next_target_enabled();
      if (!next_target_enabled && get_active_session_count() > 0) {
        set_disable_modal_state(true, false);
        return;
      }

      queue_toggle_target_enabled(next_target_enabled);
      return;
    }

    if (action === "disable-modal-cancel") {
      set_disable_modal_state(false, false);
      return;
    }

    if (action === "disable-modal-disable-only") {
      set_disable_modal_state(false, false);
      queue_toggle_target_enabled(false);
      return;
    }

    if (action === "disable-modal-close-all") {
      void run_disable_with_close_all_sessions();
      return;
    }

    if (action === "cleanup-modal-cancel") {
      set_cleanup_modal_state(false);
      return;
    }

    if (action === "cleanup-modal-save") {
      void run_cleanup_modal_save();
      return;
    }

    if (action === "cleanup-modal-run-now") {
      void run_cleanup_now();
      return;
    }

    if (action === "save-port") {
      const next_port = read_port_input_value();
      void run_action(async () => {
        await send_ui_message<popup_state>("ui_set_port", {
          port: next_port,
        });
      });
      return;
    }

    if (action === "copy-bridge-url") {
      void copy_bridge_url();
      return;
    }

    if (action === "goto-tab") {
      const tab_id = Number.parseInt(button.dataset.tabId || "", 10);
      void run_action(async () => {
        await send_ui_message("ui_navigate_to_tab", { tab_id });
      });
      return;
    }

    if (action === "detach-tab") {
      const tab_id = Number.parseInt(button.dataset.tabId || "", 10);
      void run_action(async () => {
        await send_ui_message("ui_detach_locked_tab", { tab_id });
      });
      return;
    }

    if (action === "close-session") {
      const agent_session_id = button.dataset.agentSessionId;
      void run_action(async () => {
        await send_ui_message("ui_close_session", { agent_session_id });
      });
      return;
    }
  });

  browser_api.runtime.onMessage.addListener((message: { type?: string }) => {
    if (!message || message.type !== "ui_state_changed") {
      return;
    }

    request_live_refresh();
  });
}

register_event_listeners();
void refresh_state();
