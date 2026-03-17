// Modified by [KnotFalse]

import { reconnect_scheduler } from "./reconnect_scheduler.js";
import { socket_attempt_lifecycle } from "./socket_attempt_lifecycle.js";

const extension_id = chrome.runtime.id;
const default_bridge_url = "ws://127.0.0.1:37777/extension";
const default_mcp_port = 37777;
const min_port = 1;
const max_port = 65535;

/** @type {Set<number>} */
const attached_tab_ids = new Set();

/** @type {Map<number, Array<{level: string, text: string, timestamp: number}>>} */
const console_messages_by_tab = new Map();

/** @type {Map<number, Map<string, any>>} */
const network_requests_by_tab = new Map();

/** @type {Map<number, Map<string, any>>} */
const element_refs_by_tab = new Map();

/** @type {Map<number, number>} */
const element_ref_revision_by_tab = new Map();

let bridge_socket = null;
let bridge_url = default_bridge_url;
let mcp_port = default_mcp_port;
let extension_enabled = true;
let heartbeat_timer = null;
let bridge_connection_state = "idle";
let bridge_socket_generation = 0;
let allow_immediate_reconnect = false;
let reconnect_failure_started_at_ms = 0;
let reconnect_failure_count = 0;
let last_transient_failure_log_at_ms = 0;
let last_persistent_failure_log_at_ms = 0;
let last_waiting_hint_log_at_ms = 0;
let fallback_reconnect_timer = null;
let reconnect_scheduler_fault_logged = false;
let next_reconnect_attempt_at_ms = null;
let last_poll_attempt_at_ms = null;
let poll_attempt_serial = 0;
let last_connect_failure_reason = null;
let last_connect_failure_details = null;
let last_connect_failure_at_ms = null;
let latest_tabs_snapshot = [];
let latest_connections_snapshot = {
  type: "connections_snapshot",
  generated_at: now(),
  sessions: [],
  locks: [],
};

/** @type {Map<string, {resolve: (value: any) => void, reject: (reason: any) => void, timeout_id: number}>} */
const pending_ui_admin_requests = new Map();

const reconnect_policy = new reconnect_scheduler({
  base_delay_ms: 1000,
  max_delay_ms: 15000,
  jitter_ratio: 0.2,
});
const connect_attempt_lifecycle = new socket_attempt_lifecycle();

const transient_failure_log_interval_ms = 5000;
const persistent_failure_error_threshold_ms = 60000;
const persistent_failure_log_interval_ms = 300000;
const waiting_hint_log_interval_ms = 60000;
const ui_admin_request_timeout_ms = 10000;

function log(...args) {
  console.info("[local-mcp-bun-extension]", ...args);
}

function log_warn(...args) {
  console.warn("[local-mcp-bun-extension]", ...args);
}

function log_error(...args) {
  console.error("[local-mcp-bun-extension]", ...args);
}

function create_extension_error(code, message, details, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.retryable = retryable;
  return error;
}

function get_element_ref_store(tab_id) {
  let store = element_refs_by_tab.get(tab_id);
  if (!store) {
    store = new Map();
    element_refs_by_tab.set(tab_id, store);
  }

  return store;
}

function get_element_ref_revision(tab_id) {
  return element_ref_revision_by_tab.get(tab_id) || 0;
}

function reset_element_refs_for_tab(tab_id) {
  element_refs_by_tab.set(tab_id, new Map());
  element_ref_revision_by_tab.set(tab_id, get_element_ref_revision(tab_id) + 1);
}

function register_element_ref(tab_id, descriptor) {
  const store = get_element_ref_store(tab_id);
  const revision = get_element_ref_revision(tab_id);
  const element_ref = `el_${tab_id}_${revision}_${store.size + 1}`;
  store.set(element_ref, {
    ...descriptor,
    revision,
  });
  return element_ref;
}

function resolve_element_ref_entry(tab_id, element_ref) {
  const entry = element_refs_by_tab.get(tab_id)?.get(element_ref);
  if (!entry || entry.revision !== get_element_ref_revision(tab_id)) {
    throw create_extension_error("STALE_ELEMENT_REFERENCE", `element_ref is stale: ${element_ref}`, {
      tab_id,
      element_ref,
      recovery_hint: "refresh browser_snapshot or browser_lookup and retry",
    });
  }

  return entry;
}

function now() {
  return new Date().toISOString();
}

function build_bridge_url(port) {
  return `ws://127.0.0.1:${port}/extension`;
}

function parse_valid_port(input) {
  if (typeof input !== "number" || !Number.isInteger(input)) {
    return null;
  }

  if (input < min_port || input > max_port) {
    return null;
  }

  return input;
}

function parse_port_from_bridge_url(candidate_url) {
  if (typeof candidate_url !== "string") {
    return null;
  }

  const match = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/extension$/.exec(candidate_url);
  if (!match) {
    return null;
  }

  return parse_valid_port(Number.parseInt(match[1], 10));
}

async function init() {
  await hydrate_bridge_config();
  register_runtime_listeners();
  register_debugger_detach_listener();
  register_debugger_event_listener();
  register_ui_message_listener();

  if (extension_enabled) {
    connect_bridge("init");
  } else {
    bridge_connection_state = "idle";
    log("bridge autoconnect disabled by user preference");
  }

  chrome.alarms.create("bridge-heartbeat", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "bridge-heartbeat") {
      return;
    }

    if (!extension_enabled) {
      return;
    }

    if (!bridge_socket || bridge_socket.readyState !== WebSocket.OPEN) {
      schedule_bridge_reconnect("alarm");
      return;
    }

    send_tabs_update().catch((error) => {
      log_warn("tabs update failed", error);
    });
  });
}

function register_debugger_event_listener() {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tab_id = source.tabId;
    if (typeof tab_id !== "number") {
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const request_id = params?.requestId;
      if (typeof request_id !== "string") {
        return;
      }

      const requests_map = get_network_store(tab_id);
      requests_map.set(request_id, {
        request_id,
        url: params?.request?.url ?? "",
        method: params?.request?.method ?? "GET",
        type: params?.type ?? "other",
        status: undefined,
        response_headers: undefined,
        request_headers: params?.request?.headers ?? {},
        timestamp: Date.now(),
      });
      prune_network_store(requests_map, 750);
      return;
    }

    if (method === "Network.responseReceived") {
      const request_id = params?.requestId;
      if (typeof request_id !== "string") {
        return;
      }

      const requests_map = get_network_store(tab_id);
      const existing = requests_map.get(request_id) ?? {
        request_id,
        timestamp: Date.now(),
      };

      existing.status = params?.response?.status;
      existing.status_text = params?.response?.statusText;
      existing.response_headers = params?.response?.headers ?? {};
      existing.mime_type = params?.response?.mimeType;
      requests_map.set(request_id, existing);
      return;
    }

    if (method === "Network.loadingFinished") {
      const request_id = params?.requestId;
      if (typeof request_id !== "string") {
        return;
      }

      const requests_map = get_network_store(tab_id);
      const existing = requests_map.get(request_id);
      if (!existing) {
        return;
      }

      existing.finished = true;
      existing.encoded_data_length = params?.encodedDataLength;
      existing.completed_at = Date.now();
      return;
    }

    if (method === "Network.loadingFailed") {
      const request_id = params?.requestId;
      if (typeof request_id !== "string") {
        return;
      }

      const requests_map = get_network_store(tab_id);
      const existing = requests_map.get(request_id) ?? {
        request_id,
        timestamp: Date.now(),
      };

      existing.failed = true;
      existing.error_text = params?.errorText;
      existing.completed_at = Date.now();
      requests_map.set(request_id, existing);
      return;
    }

    if (method === "Runtime.consoleAPICalled") {
      const level = typeof params?.type === "string" ? params.type : "log";
      const args = Array.isArray(params?.args) ? params.args : [];
      const text = args
        .map((entry) => {
          if (entry && typeof entry.value !== "undefined") {
            return String(entry.value);
          }

          if (entry && typeof entry.description === "string") {
            return entry.description;
          }

          return "";
        })
        .filter(Boolean)
        .join(" ");

      push_console_message(tab_id, {
        level,
        text,
        timestamp: Date.now(),
      });
    }
  });
}

async function hydrate_bridge_config() {
  const result = await chrome.storage.local.get(["bridge_url", "mcp_port", "extension_enabled"]);

  if (typeof result.extension_enabled === "boolean") {
    extension_enabled = result.extension_enabled;
  }

  const stored_port_candidate =
    typeof result.mcp_port === "number"
      ? result.mcp_port
      : typeof result.mcp_port === "string"
        ? Number.parseInt(result.mcp_port, 10)
        : NaN;
  const port_from_storage = parse_valid_port(stored_port_candidate);
  const port_from_url = parse_port_from_bridge_url(result.bridge_url);
  mcp_port = port_from_storage ?? port_from_url ?? default_mcp_port;
  bridge_url = build_bridge_url(mcp_port);
}

function is_socket_active(socket, socket_generation) {
  return bridge_socket === socket && bridge_socket_generation === socket_generation;
}

function reset_reconnect_failures() {
  reconnect_failure_started_at_ms = 0;
  reconnect_failure_count = 0;
  last_transient_failure_log_at_ms = 0;
  last_persistent_failure_log_at_ms = 0;
  last_waiting_hint_log_at_ms = 0;
}

function clear_connect_failure_telemetry() {
  last_connect_failure_reason = null;
  last_connect_failure_details = null;
  last_connect_failure_at_ms = null;
}

function set_connect_failure_telemetry(reason, details = "") {
  last_connect_failure_reason = reason;
  last_connect_failure_details = details;
  last_connect_failure_at_ms = Date.now();
}

function resolve_waiting_connection_hint() {
  if (!extension_enabled || bridge_connection_state === "open") {
    return "";
  }

  if (last_connect_failure_reason === "socket_error") {
    return `Waiting for bridge listener at ${bridge_url}. Start MCP server and confirm port ${mcp_port}.`;
  }

  if (last_connect_failure_reason === "socket_close") {
    return `Bridge dropped (${last_connect_failure_details || "unexpected close"}); reconnecting to ${bridge_url}.`;
  }

  return `Waiting for bridge listener at ${bridge_url}.`;
}

function maybe_log_waiting_bridge_hint() {
  const now_ms = Date.now();
  if (now_ms - last_waiting_hint_log_at_ms < waiting_hint_log_interval_ms) {
    return;
  }

  last_waiting_hint_log_at_ms = now_ms;
  log_warn(`waiting for bridge listener at ${bridge_url}; ensure MCP server is running and BRIDGE_PORT=${mcp_port}`);
}

function clear_fallback_reconnect_timer() {
  if (fallback_reconnect_timer === null) {
    return false;
  }

  globalThis.clearTimeout(fallback_reconnect_timer);
  fallback_reconnect_timer = null;
  return true;
}

function clear_pending_ui_admin_requests(reason = "bridge unavailable") {
  for (const pending of pending_ui_admin_requests.values()) {
    globalThis.clearTimeout(pending.timeout_id);
    pending.reject(new Error(reason));
  }

  pending_ui_admin_requests.clear();
}

function clear_reconnect_poll_telemetry() {
  next_reconnect_attempt_at_ms = null;
}

function notify_ui_state_change() {
  chrome.runtime.sendMessage({ type: "ui_state_changed" }).catch(() => {
    // Popup may not be open.
  });
}

function record_reconnect_failure(reason, details = "") {
  set_connect_failure_telemetry(reason, details);
  const now_ms = Date.now();
  if (reconnect_failure_started_at_ms === 0) {
    reconnect_failure_started_at_ms = now_ms;
  }

  reconnect_failure_count += 1;
  const failure_duration_ms = now_ms - reconnect_failure_started_at_ms;
  const detail_suffix = details.length > 0 ? ` (${details})` : "";

  if (failure_duration_ms >= persistent_failure_error_threshold_ms) {
    if (now_ms - last_persistent_failure_log_at_ms < persistent_failure_log_interval_ms) {
      return;
    }

    last_persistent_failure_log_at_ms = now_ms;
    log_error(
      `bridge reconnect still failing after ${failure_duration_ms}ms; failures=${reconnect_failure_count}; reason=${reason}${detail_suffix}`,
    );
    maybe_log_waiting_bridge_hint();
    return;
  }

  if (now_ms - last_transient_failure_log_at_ms < transient_failure_log_interval_ms) {
    return;
  }

  last_transient_failure_log_at_ms = now_ms;
  log_warn(`bridge reconnect pending; failures=${reconnect_failure_count}; reason=${reason}${detail_suffix}`);
  maybe_log_waiting_bridge_hint();
}

function schedule_bridge_reconnect(reason) {
  if (!extension_enabled) {
    return;
  }

  if (bridge_connection_state === "open") {
    return;
  }

  let scheduled;
  try {
    scheduled = reconnect_policy.schedule(() => {
      connect_bridge(`reconnect:${reason}`);
    });
  } catch (error) {
    if (!reconnect_scheduler_fault_logged) {
      reconnect_scheduler_fault_logged = true;
      log_error("reconnect scheduler failed; using fallback timer", error);
    }

    if (fallback_reconnect_timer !== null) {
      return;
    }

    fallback_reconnect_timer = globalThis.setTimeout(() => {
      fallback_reconnect_timer = null;
      if (bridge_connection_state !== "open") {
        connect_bridge(`fallback:${reason}`);
      }
    }, 1000);
    next_reconnect_attempt_at_ms = Date.now() + 1000;
    notify_ui_state_change();
    return;
  }

  if (!scheduled.scheduled) {
    return;
  }

  clear_fallback_reconnect_timer();
  next_reconnect_attempt_at_ms = Date.now() + scheduled.delay_ms;
  notify_ui_state_change();
  log(`bridge reconnect scheduled in ${scheduled.delay_ms}ms (attempt=${scheduled.attempt}, reason=${reason})`);
}

function finalize_socket_failure(socket, socket_generation, reason, details = "") {
  if (!is_socket_active(socket, socket_generation)) {
    return false;
  }

  if (!connect_attempt_lifecycle.claim_terminal(socket_generation)) {
    return false;
  }

  stop_heartbeat();
  bridge_socket = null;
  bridge_connection_state = "idle";
  clear_pending_ui_admin_requests("extension bridge disconnected");

  if (!extension_enabled) {
    notify_ui_state_change();
    return true;
  }

  record_reconnect_failure(reason, details);

  if (allow_immediate_reconnect) {
    allow_immediate_reconnect = false;
    connect_bridge(`${reason}_immediate`);
  }

  schedule_bridge_reconnect(reason);
  notify_ui_state_change();
  return true;
}

function connect_bridge(reason = "manual") {
  if (!extension_enabled) {
    return false;
  }

  if (bridge_connection_state === "connecting") {
    return false;
  }

  if (bridge_socket && (bridge_socket.readyState === WebSocket.OPEN || bridge_socket.readyState === WebSocket.CONNECTING)) {
    return false;
  }

  bridge_connection_state = "connecting";
  clear_reconnect_poll_telemetry();
  last_poll_attempt_at_ms = Date.now();
  poll_attempt_serial += 1;
  bridge_socket_generation += 1;
  const socket_generation = bridge_socket_generation;
  connect_attempt_lifecycle.begin(socket_generation);
  const socket = new WebSocket(bridge_url);
  bridge_socket = socket;

  log(`bridge connecting ${bridge_url} (reason=${reason})`);
  notify_ui_state_change();

  socket.addEventListener("open", () => {
    if (!is_socket_active(socket, socket_generation)) {
      return;
    }

    bridge_connection_state = "open";
    allow_immediate_reconnect = true;
    reconnect_policy.reset();
    clear_fallback_reconnect_timer();
    reconnect_scheduler_fault_logged = false;
    reset_reconnect_failures();
    clear_connect_failure_telemetry();
    log("bridge connected", bridge_url);
    send_json({
      type: "register",
      extension_id,
      connected_at: now(),
    });

    send_tabs_update().catch((error) => {
      log_warn("tabs update on open failed", error);
    });

    start_heartbeat();
    notify_ui_state_change();
  });

  socket.addEventListener("message", (event) => {
    if (!is_socket_active(socket, socket_generation)) {
      return;
    }

    handle_bridge_message(event.data).catch((error) => {
      log_error("bridge message handler failed", error);
    });
  });

  socket.addEventListener("close", (event) => {
    finalize_socket_failure(socket, socket_generation, "socket_close", `code=${event.code}; reason=${event.reason || "none"}`);
  });

  socket.addEventListener("error", () => {
    finalize_socket_failure(socket, socket_generation, "socket_error");
  });

  return true;
}

function disconnect_bridge(reason = "manual_disconnect") {
  clear_fallback_reconnect_timer();
  reconnect_policy.reset();
  reset_reconnect_failures();
  connect_attempt_lifecycle.clear();
  allow_immediate_reconnect = false;
  bridge_connection_state = "idle";
  clear_reconnect_poll_telemetry();
  clear_pending_ui_admin_requests(reason);
  stop_heartbeat();
  clear_connect_failure_telemetry();

  const socket = bridge_socket;
  bridge_socket = null;

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    try {
      socket.close(1000, reason);
    } catch {
      // Best-effort close.
    }
  }

  notify_ui_state_change();
}

function normalize_connections_snapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      type: "connections_snapshot",
      generated_at: now(),
      sessions: [],
      locks: [],
    };
  }

  const sessions = Array.isArray(snapshot.sessions)
    ? snapshot.sessions
        .filter((session) => session && typeof session.agent_session_id === "string")
        .map((session) => ({
          agent_session_id: String(session.agent_session_id),
          client_name: typeof session.client_name === "string" ? session.client_name : undefined,
          connected_at: typeof session.connected_at === "string" ? session.connected_at : "",
          last_seen_at: typeof session.last_seen_at === "string" ? session.last_seen_at : "",
          state: typeof session.state === "string" ? session.state : "connected",
          owned_tab_ids: Array.isArray(session.owned_tab_ids)
            ? session.owned_tab_ids.filter((tab_id) => typeof tab_id === "number")
            : [],
        }))
    : [];

  const locks = Array.isArray(snapshot.locks)
    ? snapshot.locks
        .filter((lock) => lock && typeof lock.tab_id === "number" && typeof lock.owner_agent_session_id === "string")
        .map((lock) => ({
          tab_id: Number(lock.tab_id),
          owner_agent_session_id: String(lock.owner_agent_session_id),
          lock_state: typeof lock.lock_state === "string" ? lock.lock_state : "attached",
          lock_acquired_at: typeof lock.lock_acquired_at === "string" ? lock.lock_acquired_at : "",
        }))
    : [];

  return {
    type: "connections_snapshot",
    generated_at: typeof snapshot.generated_at === "string" ? snapshot.generated_at : now(),
    sessions,
    locks,
  };
}

function resolve_ui_admin_response(response) {
  const request_id = response?.request_id;
  if (typeof request_id !== "string") {
    return;
  }

  const pending = pending_ui_admin_requests.get(request_id);
  if (!pending) {
    return;
  }

  pending_ui_admin_requests.delete(request_id);
  globalThis.clearTimeout(pending.timeout_id);

  if (response.ok !== true) {
    pending.reject(new Error(typeof response.error === "string" ? response.error : "ui admin request failed"));
    return;
  }

  pending.resolve(response.result);
}

async function send_ui_admin_request(action, payload) {
  if (!bridge_socket || bridge_socket.readyState !== WebSocket.OPEN || bridge_connection_state !== "open") {
    throw new Error("extension bridge is not connected");
  }

  const request_id = crypto.randomUUID();
  return await new Promise((resolve, reject) => {
    const timeout_id = globalThis.setTimeout(() => {
      pending_ui_admin_requests.delete(request_id);
      reject(new Error(`ui admin request timed out: ${action}`));
    }, ui_admin_request_timeout_ms);

    pending_ui_admin_requests.set(request_id, {
      resolve,
      reject,
      timeout_id,
    });

    send_json({
      type: "ui_admin_request",
      request_id,
      action,
      payload,
    });
  });
}

async function sync_tabs_snapshot(send_update = true) {
  const tabs = await get_tabs_snapshot();
  latest_tabs_snapshot = tabs;

  if (send_update) {
    send_json({ type: "tabs_update", tabs });
    notify_ui_state_change();
  }

  return tabs;
}

async function get_ui_state() {
  await sync_tabs_snapshot(false);
  return {
    extension_enabled,
    bridge_connection_state,
    next_reconnect_attempt_at_ms,
    last_poll_attempt_at_ms,
    poll_attempt_serial,
    last_connect_failure_reason,
    last_connect_failure_details,
    last_connect_failure_at_ms,
    connection_hint: resolve_waiting_connection_hint(),
    bridge_url,
    mcp_port,
    tabs: latest_tabs_snapshot,
    connections_snapshot: latest_connections_snapshot,
  };
}

async function set_extension_enabled(next_enabled) {
  if (typeof next_enabled !== "boolean") {
    throw new Error("enabled must be boolean");
  }

  if (extension_enabled === next_enabled) {
    return await get_ui_state();
  }

  extension_enabled = next_enabled;
  await chrome.storage.local.set({ extension_enabled });

  if (!extension_enabled) {
    disconnect_bridge("disabled_by_user");
  } else {
    connect_bridge("enabled_by_user");
  }

  return await get_ui_state();
}

async function set_mcp_port(next_port) {
  const validated_port = parse_valid_port(next_port);
  if (validated_port === null) {
    throw new Error(`port must be an integer between ${min_port} and ${max_port}`);
  }

  mcp_port = validated_port;
  bridge_url = build_bridge_url(mcp_port);
  await chrome.storage.local.set({
    mcp_port,
    bridge_url,
  });

  if (extension_enabled) {
    disconnect_bridge("port_changed");
    connect_bridge("port_changed");
  } else {
    notify_ui_state_change();
  }

  return await get_ui_state();
}

async function navigate_to_tab(tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const tab = await chrome.tabs.get(resolved_tab_id);
  await chrome.tabs.update(resolved_tab_id, { active: true });
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  return {
    tab_id: resolved_tab_id,
    url: tab.url ?? "",
    title: tab.title ?? "",
  };
}

function register_ui_message_listener() {
  chrome.runtime.onMessage.addListener((message, _sender, send_response) => {
    if (!message || typeof message.type !== "string" || !message.type.startsWith("ui_")) {
      return false;
    }

    (async () => {
      if (message.type === "ui_get_state") {
        return await get_ui_state();
      }

      if (message.type === "ui_set_enabled") {
        return await set_extension_enabled(message.enabled);
      }

      if (message.type === "ui_set_port") {
        const parsed_port =
          typeof message.port === "number"
            ? message.port
            : typeof message.port === "string"
              ? Number.parseInt(message.port, 10)
              : NaN;
        return await set_mcp_port(parsed_port);
      }

      if (message.type === "ui_navigate_to_tab") {
        return await navigate_to_tab(message.tab_id);
      }

      if (message.type === "ui_detach_tab") {
        const tab_id = assert_tab_id(message.tab_id);
        await send_ui_admin_request("detach_tab_lock", {
          tab_id,
        });
        await sync_tabs_snapshot();
        return {
          detached: true,
          tab_id,
        };
      }

      if (message.type === "ui_detach_locked_tab") {
        const tab_id = assert_tab_id(message.tab_id);
        await send_ui_admin_request("detach_tab_lock", {
          tab_id,
        });
        await sync_tabs_snapshot();
        return {
          detached: true,
          tab_id,
        };
      }

      if (message.type === "ui_close_session") {
        const agent_session_id = message.agent_session_id;
        if (typeof agent_session_id !== "string" || agent_session_id.length === 0) {
          throw new Error("agent_session_id is required");
        }

        const result = await send_ui_admin_request("close_session", {
          agent_session_id,
        });

        return result;
      }

      if (message.type === "ui_close_all_sessions") {
        const result = await send_ui_admin_request("close_all_sessions", {});
        return result;
      }

      throw new Error(`unsupported ui message: ${message.type}`);
    })()
      .then((result) => {
        send_response({
          ok: true,
          result,
        });
      })
      .catch((error) => {
        send_response({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  });
}

function register_runtime_listeners() {
  chrome.tabs.onUpdated.addListener((_tab_id, change_info) => {
    if (!change_info.url && !change_info.status) {
      return;
    }

    send_tabs_update().catch((error) => {
      log_warn("tabs update on tab change failed", error);
    });
  });

  chrome.tabs.onRemoved.addListener((tab_id) => {
    attached_tab_ids.delete(tab_id);
    network_requests_by_tab.delete(tab_id);
    console_messages_by_tab.delete(tab_id);

    send_json({
      type: "detach_notice",
      tab_id,
      reason: "target_closed",
    });

    send_tabs_update().catch((error) => {
      log_warn("tabs update on remove failed", error);
    });
  });
}

function register_debugger_detach_listener() {
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tab_id = source.tabId;
    if (typeof tab_id !== "number") {
      return;
    }

    attached_tab_ids.delete(tab_id);
    network_requests_by_tab.delete(tab_id);

    send_json({
      type: "detach_notice",
      tab_id,
      reason,
    });

    send_tabs_update().catch((error) => {
      log_warn("tabs update on detach failed", error);
    });
  });
}

async function handle_bridge_message(raw_data) {
  let payload;

  try {
    payload = JSON.parse(String(raw_data));
  } catch {
    return;
  }

  if (payload?.type === "connections_snapshot") {
    latest_connections_snapshot = normalize_connections_snapshot(payload);
    notify_ui_state_change();
    return;
  }

  if (payload?.type === "ui_admin_response") {
    resolve_ui_admin_response(payload);
    return;
  }

  if (!payload || payload.type !== "request" || typeof payload.request_id !== "string") {
    return;
  }

  const request_id = payload.request_id;
  const safe_agent_session_id =
    typeof payload.agent_session_id === "string" && payload.agent_session_id.length > 0
      ? payload.agent_session_id
      : "unknown-session";

  try {
    if (typeof payload.agent_session_id !== "string" || payload.agent_session_id.length === 0) {
      throw new Error("request requires non-empty agent_session_id");
    }

    if (payload.action === "list_tabs") {
      const tabs = await get_tabs_snapshot();
      send_response(request_id, payload.agent_session_id, true, { tabs });
      return;
    }

    if (payload.action === "attach_to_tab") {
      const tab_id = payload.payload?.tab_id;
      await attach_to_tab(tab_id);
      send_response(request_id, payload.agent_session_id, true, { attached: true, tab_id });
      await send_tabs_update();
      return;
    }

    if (payload.action === "detach_from_tab") {
      const tab_id = payload.payload?.tab_id;
      await detach_from_tab(tab_id);
      send_response(request_id, payload.agent_session_id, true, { detached: true, tab_id });
      await send_tabs_update();
      return;
    }

    if (payload.action === "call_tool") {
      const tool_name = payload.payload?.tool_name;
      const args = payload.payload?.args;
      const tab_id = payload.payload?.tab_id;

      if (typeof tool_name !== "string") {
        throw new Error("call_tool requires string tool_name");
      }

      const parsed_args = args && typeof args === "object" ? args : {};
      const result = await execute_browser_tool(tool_name, parsed_args, tab_id);
      send_response(request_id, payload.agent_session_id, true, result);
      return;
    }

    send_response(request_id, payload.agent_session_id, false, undefined, `unknown action: ${payload.action}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send_response(
      request_id,
      safe_agent_session_id,
      false,
      undefined,
      message,
      typeof error?.code === "string" ? error.code : undefined,
      error?.details && typeof error.details === "object" ? error.details : undefined,
      error?.retryable === true,
    );
  }
}

async function get_tabs_snapshot() {
  const tabs = await chrome.tabs.query({});
  tabs.sort((left, right) => left.index - right.index);

  return tabs
    .filter((tab) => typeof tab.id === "number")
    .map((tab, index) => ({
      tab_id: tab.id,
      index,
      url: tab.url ?? "",
      title: tab.title ?? "",
      active: tab.active === true,
      window_id: tab.windowId,
      debugger_attached: attached_tab_ids.has(tab.id),
    }));
}

async function send_tabs_update() {
  await sync_tabs_snapshot(true);
}

async function execute_browser_tool(tool_name, args, tab_id) {
  if (tool_name === "browser_tabs") {
    return await execute_browser_tabs(args, tab_id);
  }

  if (tool_name === "browser_navigate") {
    return await execute_browser_navigate(args, tab_id);
  }

  if (tool_name === "browser_snapshot") {
    return await execute_browser_snapshot(tab_id);
  }

  if (tool_name === "browser_take_screenshot") {
    return await execute_browser_take_screenshot(args, tab_id);
  }

  if (tool_name === "browser_evaluate") {
    return await execute_browser_evaluate(args, tab_id);
  }

  if (tool_name === "browser_interact") {
    return await execute_browser_interact(args, tab_id);
  }

  if (tool_name === "browser_fill_form") {
    return await execute_browser_fill_form(args, tab_id);
  }

  if (tool_name === "browser_lookup") {
    return await execute_browser_lookup(args, tab_id);
  }

  if (tool_name === "browser_verify_text_visible") {
    return await execute_browser_verify_text_visible(args, tab_id);
  }

  if (tool_name === "browser_verify_element_visible") {
    return await execute_browser_verify_element_visible(args, tab_id);
  }

  if (tool_name === "browser_extract_content") {
    return await execute_browser_extract_content(args, tab_id);
  }

  if (tool_name === "browser_get_element_styles") {
    return await execute_browser_get_element_styles(args, tab_id);
  }

  if (tool_name === "browser_console_messages") {
    return await execute_browser_console_messages(args, tab_id);
  }

  if (tool_name === "browser_window") {
    return await execute_browser_window(args, tab_id);
  }

  if (tool_name === "browser_handle_dialog") {
    return await execute_browser_handle_dialog(args, tab_id);
  }

  if (tool_name === "browser_list_extensions") {
    return await execute_browser_list_extensions();
  }

  if (tool_name === "browser_reload_extensions") {
    return await execute_browser_reload_extensions(args);
  }

  if (tool_name === "browser_network_requests") {
    return await execute_browser_network_requests(args, tab_id);
  }

  if (tool_name === "browser_pdf_save") {
    return await execute_browser_pdf_save(args, tab_id);
  }

  if (tool_name === "browser_performance_metrics") {
    return await execute_browser_performance_metrics(tab_id);
  }

  if (tool_name === "browser_drag") {
    return await execute_browser_drag(args, tab_id);
  }

  throw new Error(`unsupported tool: ${tool_name}`);
}

async function execute_browser_tabs(args, tab_id) {
  const action = args?.action;

  if (action === "list") {
    return {
      tabs: await get_tabs_snapshot(),
    };
  }

  if (action === "new") {
    const url = typeof args.url === "string" && args.url.length > 0 ? args.url : "about:blank";
    const activate = args.activate !== false;
    const created_tab = await chrome.tabs.create({ url, active: activate });

    return {
      tab_id: created_tab.id,
      url: created_tab.url,
      title: created_tab.title,
      index: created_tab.index,
    };
  }

  if (action === "close") {
    const resolved_tab_id =
      typeof args.tab_id === "number" ? args.tab_id : typeof tab_id === "number" ? tab_id : undefined;

    if (typeof resolved_tab_id !== "number") {
      throw new Error("browser_tabs close requires tab_id");
    }

    await chrome.tabs.remove(resolved_tab_id);
    attached_tab_ids.delete(resolved_tab_id);

    return {
      closed: true,
      tab_id: resolved_tab_id,
    };
  }

  throw new Error(`unsupported browser_tabs action: ${action}`);
}

async function execute_browser_navigate(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const action = args?.action;

  if (action === "url") {
    const url = args?.url;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("browser_navigate action=url requires non-empty url");
    }

    await chrome.tabs.update(resolved_tab_id, { url });
    await wait_for_tab_complete(resolved_tab_id, 10000);
  } else if (action === "back") {
    await execute_in_tab(resolved_tab_id, () => {
      history.back();
      return true;
    });
  } else if (action === "forward") {
    await execute_in_tab(resolved_tab_id, () => {
      history.forward();
      return true;
    });
  } else if (action === "reload") {
    await chrome.tabs.reload(resolved_tab_id);
    await wait_for_tab_complete(resolved_tab_id, 10000);
  } else if (action === "test_page") {
    const test_url = "data:text/html,<html><body><h1>Local MCP Bun Test Page</h1></body></html>";
    await chrome.tabs.update(resolved_tab_id, { url: test_url });
    await wait_for_tab_complete(resolved_tab_id, 10000);
  } else {
    throw new Error(`unsupported browser_navigate action: ${action}`);
  }

  reset_element_refs_for_tab(resolved_tab_id);

  const tab = await chrome.tabs.get(resolved_tab_id);
  return {
    tab_id: resolved_tab_id,
    url: tab.url,
    title: tab.title,
    action,
  };
}

async function resolve_selector_target(args, tab_id, selector_field = "selector", element_ref_field = "element_ref") {
  const selector = typeof args?.[selector_field] === "string" ? args[selector_field].trim() : "";
  if (selector) {
    return {
      selector,
      element_ref: undefined,
    };
  }

  const element_ref = typeof args?.[element_ref_field] === "string" ? args[element_ref_field].trim() : "";
  if (!element_ref) {
    return {
      selector: "",
      element_ref: undefined,
    };
  }

  const entry = resolve_element_ref_entry(tab_id, element_ref);
  return {
    selector: entry.selector,
    element_ref,
  };
}

async function resolve_required_selector_target(args, tab_id, tool_name, selector_field = "selector", element_ref_field = "element_ref") {
  const resolved = await resolve_selector_target(args, tab_id, selector_field, element_ref_field);
  if (!resolved.selector) {
    throw create_extension_error("INVALID_ARGUMENT", `${tool_name} requires selector or element_ref`, {
      tab_id,
      tool_name,
    });
  }

  return resolved;
}

async function get_selector_center(tab_id, selector) {
  const point = await execute_in_tab(tab_id, (incoming_selector) => {
    const target = document.querySelector(incoming_selector);
    if (!target) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }, selector);

  if (!point) {
    throw create_extension_error("INVALID_ARGUMENT", `selector not found: ${selector}`, {
      tab_id,
      selector,
    });
  }

  return point;
}

async function dispatch_mouse_event(tab_id, type, x, y, button = "left", click_count = 1, buttons = 0) {
  await send_debugger_command(tab_id, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    clickCount: click_count,
    buttons,
  });
}

async function resolve_dom_node_id(tab_id, selector) {
  const document_root = await send_debugger_command(tab_id, "DOM.getDocument", {
    depth: -1,
    pierce: true,
  });
  const root_node_id = document_root?.root?.nodeId;
  if (typeof root_node_id !== "number") {
    throw create_extension_error("ATTACH_FAILED", "DOM.getDocument failed to return root node", {
      tab_id,
      selector,
    });
  }

  const query_result = await send_debugger_command(tab_id, "DOM.querySelector", {
    nodeId: root_node_id,
    selector,
  });
  const node_id = query_result?.nodeId;
  if (typeof node_id !== "number" || node_id <= 0) {
    throw create_extension_error("INVALID_ARGUMENT", `selector not found: ${selector}`, {
      tab_id,
      selector,
    });
  }

  return node_id;
}

async function wait_for_selector(tab_id, selector, timeout_ms) {
  const started_at = Date.now();
  while (Date.now() - started_at < timeout_ms) {
    const found = await execute_in_tab(tab_id, (incoming_selector) => {
      const target = document.querySelector(incoming_selector);
      if (!target) {
        return false;
      }

      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }, selector);

    if (found) {
      return;
    }

    await sleep(50);
  }

  throw create_extension_error("INVALID_ARGUMENT", `wait target not found before timeout: ${selector}`, {
    tab_id,
    selector,
    timeout_ms,
  });
}

async function force_pseudo_state(tab_id, selector, pseudo_state) {
  const node_id = await resolve_dom_node_id(tab_id, selector);
  await send_debugger_command(tab_id, "CSS.enable", {});
  await send_debugger_command(tab_id, "CSS.forcePseudoState", {
    nodeId: node_id,
    forcedPseudoClasses: [pseudo_state],
  });
}

async function execute_browser_snapshot(tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  reset_element_refs_for_tab(resolved_tab_id);

  const page_snapshot = await execute_in_tab(resolved_tab_id, () => {
    function infer_role(element) {
      const explicit_role = element.getAttribute("role");
      if (explicit_role) {
        return explicit_role;
      }

      const tag = element.tagName.toLowerCase();
      if (tag === "a" && element.getAttribute("href")) {
        return "link";
      }

      if (tag === "button") {
        return "button";
      }

      if (tag === "select") {
        return "combobox";
      }

      if (tag === "textarea") {
        return "textbox";
      }

      if (tag === "input") {
        const type = String(element.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") {
          return "checkbox";
        }

        if (type === "radio") {
          return "radio";
        }

        if (type === "button" || type === "submit" || type === "reset") {
          return "button";
        }

        return "textbox";
      }

      if (/^h[1-6]$/u.test(tag)) {
        return "heading";
      }

      if (tag === "main") {
        return "main";
      }

      if (tag === "nav") {
        return "navigation";
      }

      if (tag === "form") {
        return "form";
      }

      return tag;
    }

    function infer_name(element) {
      const aria_label = element.getAttribute("aria-label");
      if (aria_label && aria_label.trim()) {
        return aria_label.trim().slice(0, 160);
      }

      const labelled_by = element.getAttribute("aria-labelledby");
      if (labelled_by) {
        const label_text = labelled_by
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.innerText || "")
          .join(" ")
          .trim();
        if (label_text) {
          return label_text.slice(0, 160);
        }
      }

      const placeholder = element.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) {
        return placeholder.trim().slice(0, 160);
      }

      const alt = element.getAttribute("alt");
      if (alt && alt.trim()) {
        return alt.trim().slice(0, 160);
      }

      const value = "value" in element ? String(element.value || "").trim() : "";
      if (value) {
        return value.slice(0, 160);
      }

      const text = (element.innerText || element.textContent || "").trim();
      if (text) {
        return text.slice(0, 160);
      }

      return "";
    }

    function is_visible(element) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function selector_for(element) {
      if (element.id) {
        return `#${element.id}`;
      }

      const data_test_id = element.getAttribute("data-testid");
      if (data_test_id) {
        return `[data-testid="${String(data_test_id).replace(/"/gu, '\\"')}"]`;
      }

      const name = element.getAttribute("name");
      if (name) {
        return `${element.tagName.toLowerCase()}[name="${String(name).replace(/"/gu, '\\"')}"]`;
      }

      const segments = [];
      let current = element;
      while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE && segments.length < 6) {
        let segment = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const same_tag_siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current.tagName);
          if (same_tag_siblings.length > 1) {
            segment += `:nth-of-type(${same_tag_siblings.indexOf(current) + 1})`;
          }
        }

        segments.unshift(segment);
        current = current.parentElement;
      }

      return ["body", ...segments].join(" > ");
    }

    const candidates = new Set([document.body]);
    for (const element of Array.from(
      document.querySelectorAll("a[href],button,input,select,textarea,summary,[role],[tabindex],label,h1,h2,h3,h4,h5,h6,main,nav,article,section,form"),
    )) {
      candidates.add(element);
    }

    const nodes = Array.from(candidates)
      .map((element) => {
        const role = infer_role(element);
        const visible = is_visible(element);
        const interactive = ["link", "button", "textbox", "checkbox", "radio", "combobox"].includes(role);
        return {
          tag: element.tagName.toLowerCase(),
          role,
          name: infer_name(element),
          text: (element.innerText || element.textContent || "").trim().slice(0, 200),
          visible,
          interactive,
          selector: selector_for(element),
          disabled: element.hasAttribute("disabled"),
        };
      })
      .filter((node) => node.visible || node.interactive || node.tag === "body")
      .sort((left, right) => Number(right.interactive) - Number(left.interactive) || Number(right.visible) - Number(left.visible))
      .slice(0, 80);

    return {
      url: location.href,
      title: document.title,
      nodes,
    };
  });

  const snapshot = Array.isArray(page_snapshot?.nodes)
    ? page_snapshot.nodes.map((node) => ({
        ...node,
        element_ref: register_element_ref(resolved_tab_id, {
          selector: node.selector,
          tag: node.tag,
          role: node.role,
          name: node.name,
        }),
      }))
    : [];

  return {
    tab_id: resolved_tab_id,
    url: page_snapshot?.url,
    title: page_snapshot?.title,
    snapshot,
    total_nodes: snapshot.length,
    truncated: snapshot.length >= 80,
  };
}

function clamp_screenshot_quality(raw_quality) {
  if (typeof raw_quality !== "number" || !Number.isFinite(raw_quality)) {
    return 80;
  }

  return Math.max(0, Math.min(100, Math.round(raw_quality)));
}

function estimate_base64_bytes(data_base64) {
  const normalized = data_base64.replace(/=+$/u, "");
  return Math.floor((normalized.length * 3) / 4);
}

async function execute_browser_take_screenshot(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);

  if (!attached_tab_ids.has(resolved_tab_id)) {
    throw new Error("browser_take_screenshot requires attached debugger tab");
  }

  const requested_type = typeof args?.type === "string" ? args.type.toLowerCase() : "jpeg";
  const format = requested_type === "png" ? "png" : "jpeg";
  const mime_type = format === "png" ? "image/png" : "image/jpeg";
  const quality = clamp_screenshot_quality(args?.quality);
  const resolved_target = await resolve_selector_target(args, resolved_tab_id);
  const selector = resolved_target.selector;
  const padding =
    typeof args?.padding === "number" && Number.isFinite(args.padding) ? Math.max(0, args.padding) : 0;
  const has_clip =
    typeof args?.clip_x === "number" &&
    Number.isFinite(args.clip_x) &&
    typeof args?.clip_y === "number" &&
    Number.isFinite(args.clip_y) &&
    typeof args?.clip_width === "number" &&
    Number.isFinite(args.clip_width) &&
    typeof args?.clip_height === "number" &&
    Number.isFinite(args.clip_height);

  let capture_mode = "viewport";
  let capture_beyond_viewport = Boolean(args?.fullPage);
  let final_clip = null;

  if (selector.length > 0) {
    const eval_result = await send_debugger_command(resolved_tab_id, "Runtime.evaluate", {
      expression: `
        (function() {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) {
            return null;
          }

          const rect = element.getBoundingClientRect();
          const scroll_x = window.pageXOffset || document.documentElement.scrollLeft || 0;
          const scroll_y = window.pageYOffset || document.documentElement.scrollTop || 0;
          return {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            page_x: rect.left + scroll_x,
            page_y: rect.top + scroll_y
          };
        })()
      `,
      returnByValue: true,
    });

    const bounds = eval_result?.result?.value;
    if (!bounds) {
      throw new Error(`Element not found: ${selector}`);
    }

    final_clip = {
      x: Math.max(0, Number(bounds.page_x) - padding),
      y: Math.max(0, Number(bounds.page_y) - padding),
      width: Number(bounds.width) + padding * 2,
      height: Number(bounds.height) + padding * 2,
      scale: 1,
    };
    capture_beyond_viewport = true;
    capture_mode = "selector";
  } else if (has_clip) {
    const clip_width = Number(args.clip_width);
    const clip_height = Number(args.clip_height);

    if (clip_width <= 0 || clip_height <= 0) {
      throw new Error("clip_width and clip_height must be greater than 0");
    }

    const clip_coordinate_system = args?.clip_coordinateSystem === "page" ? "page" : "viewport";
    if (clip_coordinate_system === "page") {
      const scroll_result = await send_debugger_command(resolved_tab_id, "Runtime.evaluate", {
        expression: `({x: window.pageXOffset || document.documentElement.scrollLeft || 0, y: window.pageYOffset || document.documentElement.scrollTop || 0})`,
        returnByValue: true,
      });
      const scroll = scroll_result?.result?.value ?? { x: 0, y: 0 };

      final_clip = {
        x: Number(args.clip_x) - Number(scroll.x ?? 0),
        y: Number(args.clip_y) - Number(scroll.y ?? 0),
        width: clip_width,
        height: clip_height,
        scale: 1,
      };
    } else {
      final_clip = {
        x: Number(args.clip_x),
        y: Number(args.clip_y),
        width: clip_width,
        height: clip_height,
        scale: 1,
      };
    }

    capture_mode = "clip";
  } else if (Boolean(args?.fullPage)) {
    const metrics = await send_debugger_command(resolved_tab_id, "Page.getLayoutMetrics", {});
    const content_size = metrics?.cssContentSize ?? metrics?.contentSize;

    if (
      !content_size ||
      typeof content_size.width !== "number" ||
      typeof content_size.height !== "number" ||
      content_size.width <= 0 ||
      content_size.height <= 0
    ) {
      throw new Error("full page screenshot could not resolve layout metrics");
    }

    final_clip = {
      x: 0,
      y: 0,
      width: Math.ceil(content_size.width),
      height: Math.ceil(content_size.height),
      scale: 1,
    };
    capture_beyond_viewport = true;
    capture_mode = "full_page";
  }

  const screenshot_params = {
    format,
    quality: format === "jpeg" ? quality : undefined,
    captureBeyondViewport: capture_beyond_viewport,
  };

  if (final_clip) {
    screenshot_params.clip = final_clip;
  }

  const screenshot_result = await send_debugger_command(resolved_tab_id, "Page.captureScreenshot", screenshot_params);
  const data_base64 = typeof screenshot_result?.data === "string" ? screenshot_result.data : "";

  if (!data_base64) {
    throw new Error("Page.captureScreenshot returned empty image data");
  }

  return {
    tab_id: resolved_tab_id,
    data_base64,
    mime_type,
    format,
    bytes: estimate_base64_bytes(data_base64),
    capture_mode,
    full_page: capture_mode === "full_page",
    selector: selector.length > 0 ? selector : undefined,
    element_ref: resolved_target.element_ref,
    clip: final_clip
      ? {
          x: final_clip.x,
          y: final_clip.y,
          width: final_clip.width,
          height: final_clip.height,
        }
      : undefined,
    quality: format === "jpeg" ? quality : undefined,
  };
}

async function execute_browser_evaluate(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const expression =
    typeof args?.expression === "string"
      ? args.expression
      : typeof args?.function === "string"
        ? `(${args.function})()`
        : "";

  if (!expression) {
    throw new Error("browser_evaluate requires expression");
  }

  if (!attached_tab_ids.has(resolved_tab_id)) {
    throw new Error("browser_evaluate requires attached debugger tab");
  }

  const result = await send_debugger_command(resolved_tab_id, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result?.exceptionDetails) {
    return {
      tab_id: resolved_tab_id,
      ok: false,
      error: result.exceptionDetails.text || "Runtime.evaluate failed",
    };
  }

  const value = typeof result?.result?.value !== "undefined" ? result.result.value : result?.result?.description;

  return {
    tab_id: resolved_tab_id,
    ok: true,
    value,
    value_type: result?.result?.type,
  };
}

async function execute_browser_interact(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const actions = Array.isArray(args?.actions)
    ? args.actions
    : typeof args?.action === "string"
      ? [{ ...args, type: args.action }]
      : [];

  if (actions.length === 0) {
    throw new Error("browser_interact requires action or non-empty actions array");
  }

  const results = [];

  for (const raw_action of actions) {
    const action = raw_action && typeof raw_action === "object" ? { ...raw_action } : {};
    const type = action?.type;

    if (type === "wait") {
      const timeout = typeof action?.timeout === "number" ? action.timeout : 250;
      const wait_target = await resolve_selector_target(action, resolved_tab_id);
      if (wait_target.selector) {
        await wait_for_selector(resolved_tab_id, wait_target.selector, timeout);
      } else {
        await sleep(timeout);
      }
      results.push({
        type,
        ok: true,
        selector: wait_target.selector || undefined,
        element_ref: wait_target.element_ref,
      });
      continue;
    }

    if (type === "mouse_move" || type === "hover") {
      const resolved_target = await resolve_required_selector_target(action, resolved_tab_id, "browser_interact");
      const point = await get_selector_center(resolved_tab_id, resolved_target.selector);
      await dispatch_mouse_event(resolved_tab_id, "mouseMoved", point.x, point.y, "none", 0, 0);
      results.push({
        type,
        ok: true,
        selector: resolved_target.selector,
        element_ref: resolved_target.element_ref,
      });
      continue;
    }

    if (type === "mouse_click" || type === "click") {
      const resolved_target = await resolve_required_selector_target(action, resolved_tab_id, "browser_interact");
      const point = await get_selector_center(resolved_tab_id, resolved_target.selector);
      await dispatch_mouse_event(resolved_tab_id, "mouseMoved", point.x, point.y, "left", 1, 0);
      await dispatch_mouse_event(resolved_tab_id, "mousePressed", point.x, point.y, "left", 1, 1);
      await dispatch_mouse_event(resolved_tab_id, "mouseReleased", point.x, point.y, "left", 1, 0);
      results.push({
        type,
        ok: true,
        selector: resolved_target.selector,
        element_ref: resolved_target.element_ref,
      });
      continue;
    }

    if (type === "file_upload") {
      const resolved_target = await resolve_required_selector_target(action, resolved_tab_id, "browser_interact");
      const files = Array.isArray(action?.files) ? action.files.filter((value) => typeof value === "string") : [];
      if (files.length === 0) {
        throw create_extension_error("INVALID_ARGUMENT", "file_upload requires non-empty files[]", {
          tab_id: resolved_tab_id,
          selector: resolved_target.selector,
        });
      }

      const node_id = await resolve_dom_node_id(resolved_tab_id, resolved_target.selector);
      await send_debugger_command(resolved_tab_id, "DOM.setFileInputFiles", {
        nodeId: node_id,
        files,
      });
      results.push({
        type,
        ok: true,
        selector: resolved_target.selector,
        element_ref: resolved_target.element_ref,
        files,
      });
      continue;
    }

    if (type === "force_pseudo_state") {
      const resolved_target = await resolve_required_selector_target(action, resolved_tab_id, "browser_interact");
      const pseudo = typeof action?.pseudo === "string" ? action.pseudo : typeof action?.value === "string" ? action.value : "";
      if (!pseudo) {
        throw create_extension_error("INVALID_ARGUMENT", "force_pseudo_state requires pseudo", {
          tab_id: resolved_tab_id,
          selector: resolved_target.selector,
        });
      }

      await force_pseudo_state(resolved_tab_id, resolved_target.selector, pseudo);
      results.push({
        type,
        ok: true,
        selector: resolved_target.selector,
        element_ref: resolved_target.element_ref,
        pseudo,
      });
      continue;
    }

    const resolved_target = await resolve_selector_target(action, resolved_tab_id);
    const prepared_action = {
      ...action,
      selector: resolved_target.selector,
    };

    const action_result = await execute_in_tab(resolved_tab_id, (incoming_action) => {
      const action_type = incoming_action.type;
      const selector = incoming_action.selector;

      function resolve_target() {
        if (!selector || typeof selector !== "string") {
          return document.body;
        }

        return document.querySelector(selector);
      }

      const target = resolve_target();
      if (!target) {
        return {
          type: action_type,
          ok: false,
          error: `selector not found: ${selector}`,
        };
      }

      if (action_type === "click") {
        target.click();
        return { type: action_type, ok: true };
      }

      if (action_type === "type") {
        const text = typeof incoming_action.text === "string" ? incoming_action.text : "";
        if ("value" in target) {
          target.value = text;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return { type: action_type, ok: true };
        }

        return { type: action_type, ok: false, error: "target has no value field" };
      }

      if (action_type === "clear") {
        if ("value" in target) {
          target.value = "";
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return { type: action_type, ok: true };
        }

        return { type: action_type, ok: false, error: "target has no value field" };
      }

      if (action_type === "press_key") {
        const key = typeof incoming_action.key === "string" ? incoming_action.key : "Enter";
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
        return { type: action_type, ok: true };
      }

      if (action_type === "hover") {
        target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        return { type: action_type, ok: true };
      }

      if (action_type === "scroll_into_view") {
        target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return { type: action_type, ok: true };
      }

      if (action_type === "scroll_to") {
        window.scrollTo(Number(incoming_action.x || 0), Number(incoming_action.y || 0));
        return { type: action_type, ok: true };
      }

      if (action_type === "scroll_by") {
        window.scrollBy(Number(incoming_action.x || 0), Number(incoming_action.y || 0));
        return { type: action_type, ok: true };
      }

      if (action_type === "select_option") {
        if (target.tagName.toLowerCase() !== "select") {
          return { type: action_type, ok: false, error: "target is not select element" };
        }

        const select_element = target;
        const value = String(incoming_action.value ?? "");

        let matched = false;
        for (const option of Array.from(select_element.options)) {
          if (option.value === value || option.text === value) {
            select_element.value = option.value;
            matched = true;
            break;
          }
        }

        if (!matched) {
          return { type: action_type, ok: false, error: `option not found: ${value}` };
        }

        select_element.dispatchEvent(new Event("change", { bubbles: true }));
        return { type: action_type, ok: true };
      }

      return { type: action_type, ok: false, error: `unsupported interaction type: ${action_type}` };
    }, prepared_action);

    results.push({
      ...action_result,
      selector: resolved_target.selector || undefined,
      element_ref: resolved_target.element_ref,
    });

    if (!action_result?.ok) {
      break;
    }
  }

  return {
    tab_id: resolved_tab_id,
    results,
  };
}

async function execute_browser_fill_form(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const raw_fields = Array.isArray(args?.fields) ? args.fields : [];

  if (raw_fields.length === 0) {
    throw new Error("browser_fill_form requires fields[]");
  }

  const fields = [];
  for (const raw_field of raw_fields) {
    const field = raw_field && typeof raw_field === "object" ? raw_field : {};
    const resolved_target = await resolve_selector_target(field, resolved_tab_id);
    fields.push({
      ...field,
      selector: resolved_target.selector,
      element_ref: resolved_target.element_ref,
    });
  }

  const result = await execute_in_tab(resolved_tab_id, (incoming_fields) => {
    const statuses = [];

    for (const field of incoming_fields) {
      const selector = field.selector;
      const value = field.value;

      if (typeof selector !== "string") {
        statuses.push({ selector, ok: false, error: "selector must be string" });
        continue;
      }

      const element = document.querySelector(selector);
      if (!element) {
        statuses.push({ selector, ok: false, error: "selector not found" });
        continue;
      }

      const tag = element.tagName.toLowerCase();
      const input_type = tag === "input" ? String(element.getAttribute("type") || "text").toLowerCase() : "";

      if (tag === "select") {
        const select = element;
        const expected = String(value ?? "");
        let matched = false;
        for (const option of Array.from(select.options)) {
          if (option.value === expected || option.text === expected) {
            select.value = option.value;
            matched = true;
            break;
          }
        }

        if (!matched) {
          statuses.push({ selector, ok: false, error: `option not found: ${expected}` });
          continue;
        }

        select.dispatchEvent(new Event("change", { bubbles: true }));
        statuses.push({ selector, ok: true });
        continue;
      }

      if (input_type === "checkbox") {
        element.checked = Boolean(value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        statuses.push({ selector, ok: true });
        continue;
      }

      if (input_type === "radio") {
        if (typeof value === "string" && element.name) {
          const radio_group = document.querySelector(`input[type="radio"][name="${element.name}"][value="${value}"]`);
          if (radio_group) {
            radio_group.checked = true;
            radio_group.dispatchEvent(new Event("change", { bubbles: true }));
            statuses.push({ selector, ok: true });
            continue;
          }
        }

        element.checked = true;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        statuses.push({ selector, ok: true });
        continue;
      }

      if (!("value" in element)) {
        statuses.push({ selector, ok: false, error: "element is not input-like" });
        continue;
      }

      element.value = String(value ?? "");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      statuses.push({ selector, ok: true });
    }

    return statuses;
  }, fields);

  return {
    tab_id: resolved_tab_id,
    fields: result,
  };
}

async function execute_browser_lookup(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const text = typeof args?.text === "string" ? args.text : "";
  const limit = typeof args?.limit === "number" ? Math.max(1, Math.min(50, args.limit)) : 10;

  if (!text) {
    throw new Error("browser_lookup requires text");
  }

  const matches = await execute_in_tab(resolved_tab_id, (incoming_text, incoming_limit) => {
    const query = incoming_text.toLowerCase();
    const output = [];

    function selector_for(element) {
      if (element.id) {
        return `#${element.id}`;
      }

      let selector = element.tagName.toLowerCase();
      if (element.className && typeof element.className === "string") {
        const first_class = element.className.split(" ").filter(Boolean)[0];
        if (first_class) {
          selector += `.${first_class}`;
        }
      }

      return selector;
    }

    function infer_role(element) {
      const explicit_role = element.getAttribute("role");
      if (explicit_role) {
        return explicit_role;
      }

      const tag = element.tagName.toLowerCase();
      if (tag === "a" && element.getAttribute("href")) {
        return "link";
      }

      if (tag === "button") {
        return "button";
      }

      return tag;
    }

    for (const element of Array.from(document.querySelectorAll("body *"))) {
      const text_value = (element.innerText || "").trim();
      if (!text_value) {
        continue;
      }

      if (!text_value.toLowerCase().includes(query)) {
        continue;
      }

      output.push({
        selector: selector_for(element),
        text: text_value.slice(0, 200),
        tag: element.tagName.toLowerCase(),
        role: infer_role(element),
        name: text_value.slice(0, 120),
        visible: true,
      });

      if (output.length >= incoming_limit) {
        break;
      }
    }

    return output;
  }, text, limit);

  return {
    tab_id: resolved_tab_id,
    matches: matches.map((match) => ({
      ...match,
      element_ref: register_element_ref(resolved_tab_id, {
        selector: match.selector,
        tag: match.tag,
        role: match.role,
        name: match.name,
      }),
    })),
  };
}

async function execute_browser_verify_text_visible(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const text = typeof args?.text === "string" ? args.text : "";

  if (!text) {
    throw new Error("browser_verify_text_visible requires text");
  }

  const visible = await execute_in_tab(resolved_tab_id, (incoming_text) => {
    const body_text = (document.body?.innerText || "").toLowerCase();
    return body_text.includes(incoming_text.toLowerCase());
  }, text);

  return {
    tab_id: resolved_tab_id,
    text,
    visible,
  };
}

async function execute_browser_verify_element_visible(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const resolved_target = await resolve_required_selector_target(args, resolved_tab_id, "browser_verify_element_visible");
  const selector = resolved_target.selector;

  const visible = await execute_in_tab(resolved_tab_id, (incoming_selector) => {
    const element = document.querySelector(incoming_selector);
    if (!element) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }, selector);

  return {
    tab_id: resolved_tab_id,
    selector,
    element_ref: resolved_target.element_ref,
    visible,
  };
}

async function execute_browser_extract_content(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const mode = typeof args?.mode === "string" ? args.mode : "auto";
  const resolved_target = await resolve_selector_target(args, resolved_tab_id);
  const selector = resolved_target.selector || (typeof args?.selector === "string" ? args.selector : "body");
  const max_lines = typeof args?.max_lines === "number" ? Math.max(1, args.max_lines) : 500;
  const offset = typeof args?.offset === "number" ? Math.max(0, args.offset) : 0;

  const text = await execute_in_tab(resolved_tab_id, (incoming_mode, incoming_selector) => {
    let target = document.body;

    if (incoming_mode === "selector") {
      const found = document.querySelector(incoming_selector);
      if (found) {
        target = found;
      }
    }

    if (incoming_mode === "full") {
      target = document.documentElement;
    }

    return (target?.innerText || "").trim();
  }, mode, selector);

  const lines = text.split("\n").map((line) => line.trim());
  const sliced_lines = lines.slice(offset, offset + max_lines);

  return {
    tab_id: resolved_tab_id,
    mode,
    selector,
    element_ref: resolved_target.element_ref,
    offset,
    max_lines,
    content: sliced_lines.join("\n"),
    total_lines: lines.length,
  };
}

async function execute_browser_get_element_styles(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const resolved_target = await resolve_required_selector_target(args, resolved_tab_id, "browser_get_element_styles");
  const selector = resolved_target.selector;
  const property = typeof args?.property === "string" ? args.property : undefined;
  const pseudo_state = typeof args?.pseudoState === "string" ? args.pseudoState : "";

  if (pseudo_state) {
    await force_pseudo_state(resolved_tab_id, selector, pseudo_state);
  }

  const styles = await execute_in_tab(resolved_tab_id, (incoming_selector, incoming_property) => {
    const element = document.querySelector(incoming_selector);
    if (!element) {
      return { found: false };
    }

    const computed = getComputedStyle(element);
    if (incoming_property) {
      return {
        found: true,
        selector: incoming_selector,
        property: incoming_property,
        value: computed.getPropertyValue(incoming_property),
      };
    }

    const keys = ["display", "visibility", "position", "color", "background-color", "font-size"];
    const picked = {};
    for (const key of keys) {
      picked[key] = computed.getPropertyValue(key);
    }

    return {
      found: true,
      selector: incoming_selector,
      styles: picked,
    };
  }, selector, property);

  return {
    tab_id: resolved_tab_id,
    selector,
    element_ref: resolved_target.element_ref,
    pseudo_state: pseudo_state || undefined,
    ...styles,
  };
}

async function execute_browser_network_requests(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const action = typeof args?.action === "string" ? args.action : "list";
  const requests_map = get_network_store(resolved_tab_id);

  if (action === "clear") {
    requests_map.clear();
    return {
      tab_id: resolved_tab_id,
      cleared: true,
    };
  }

  if (action === "details") {
    const request_id = args?.requestId;
    if (typeof request_id !== "string" || request_id.length === 0) {
      throw new Error("browser_network_requests action=details requires requestId");
    }

    const details = requests_map.get(request_id);
    return {
      tab_id: resolved_tab_id,
      request: details ?? null,
    };
  }

  if (action === "replay") {
    return {
      tab_id: resolved_tab_id,
      replayed: false,
      notice: "replay is not implemented in extension v1",
    };
  }

  const limit = typeof args?.limit === "number" ? Math.max(1, Math.min(500, args.limit)) : 50;
  const offset = typeof args?.offset === "number" ? Math.max(0, args.offset) : 0;
  const method_filter = typeof args?.method === "string" ? args.method.toUpperCase() : undefined;
  const status_filter = typeof args?.status === "number" ? args.status : undefined;
  const url_pattern = typeof args?.urlPattern === "string" ? args.urlPattern.toLowerCase() : undefined;

  let rows = Array.from(requests_map.values());
  rows.sort((left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0));

  if (method_filter) {
    rows = rows.filter((row) => String(row.method || "").toUpperCase() === method_filter);
  }

  if (typeof status_filter === "number") {
    rows = rows.filter((row) => Number(row.status) === status_filter);
  }

  if (url_pattern) {
    rows = rows.filter((row) => String(row.url || "").toLowerCase().includes(url_pattern));
  }

  return {
    tab_id: resolved_tab_id,
    total: rows.length,
    requests: rows.slice(offset, offset + limit),
  };
}

async function execute_browser_pdf_save(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  if (!attached_tab_ids.has(resolved_tab_id)) {
    throw new Error("browser_pdf_save requires attached debugger tab");
  }

  const result = await send_debugger_command(resolved_tab_id, "Page.printToPDF", {
    printBackground: true,
    preferCSSPageSize: true,
    landscape: args?.landscape === true,
  });

  const data = result?.data;
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("printToPDF returned no data");
  }

  return {
    tab_id: resolved_tab_id,
    data_base64: data,
    bytes: Math.floor((data.length * 3) / 4),
  };
}

async function execute_browser_console_messages(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const limit = typeof args?.limit === "number" ? Math.max(1, args.limit) : 50;
  const offset = typeof args?.offset === "number" ? Math.max(0, args.offset) : 0;

  const messages = console_messages_by_tab.get(resolved_tab_id) || [];

  return {
    tab_id: resolved_tab_id,
    messages: messages.slice(offset, offset + limit),
  };
}

async function execute_browser_window(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const tab = await chrome.tabs.get(resolved_tab_id);
  if (!tab.windowId) {
    throw new Error("tab window not available");
  }

  const action = args?.action;
  if (action === "resize") {
    const width = typeof args?.width === "number" ? args.width : 1280;
    const height = typeof args?.height === "number" ? args.height : 720;
    await chrome.windows.update(tab.windowId, { width, height, state: "normal" });
    return { action, window_id: tab.windowId, width, height };
  }

  if (action === "maximize") {
    await chrome.windows.update(tab.windowId, { state: "maximized" });
    return { action, window_id: tab.windowId };
  }

  if (action === "minimize") {
    await chrome.windows.update(tab.windowId, { state: "minimized" });
    return { action, window_id: tab.windowId };
  }

  if (action === "close") {
    await chrome.windows.remove(tab.windowId);
    return { action, window_id: tab.windowId };
  }

  throw new Error(`unsupported browser_window action: ${action}`);
}

async function execute_browser_handle_dialog(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const accept = args?.accept !== false;
  const text = typeof args?.text === "string" ? args.text : undefined;

  if (!attached_tab_ids.has(resolved_tab_id)) {
    throw new Error("browser_handle_dialog requires debugger attachment");
  }

  await send_debugger_command(resolved_tab_id, "Page.handleJavaScriptDialog", {
    accept,
    promptText: text,
  });

  return {
    tab_id: resolved_tab_id,
    handled: true,
    accept,
  };
}

async function execute_browser_list_extensions() {
  const extensions = await chrome.management.getAll();
  return {
    extensions: extensions
      .filter((extension) => extension.type === "extension")
      .map((extension) => ({
        id: extension.id,
        name: extension.name,
        enabled: extension.enabled,
        install_type: extension.installType,
      })),
  };
}

async function execute_browser_reload_extensions(args) {
  const extension_name = typeof args?.extensionName === "string" ? args.extensionName : undefined;
  const current_extension_id = chrome.runtime.id;
  const extensions = await chrome.management.getAll();

  const reloaded = [];

  for (const extension of extensions) {
    if (extension.type !== "extension" || extension.installType !== "development" || !extension.enabled) {
      continue;
    }

    if (extension_name && extension.name !== extension_name) {
      continue;
    }

    if (extension.id === current_extension_id) {
      continue;
    }

    await chrome.management.setEnabled(extension.id, false);
    await chrome.management.setEnabled(extension.id, true);
    reloaded.push(extension.name);
  }

  return {
    reloaded,
  };
}

async function execute_browser_performance_metrics(tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const metrics = await execute_in_tab(resolved_tab_id, () => {
    const timing = performance.timing;
    const navigation_start = timing.navigationStart;

    return {
      navigation_start,
      dom_content_loaded: timing.domContentLoadedEventEnd - navigation_start,
      load_event_end: timing.loadEventEnd - navigation_start,
      response_start: timing.responseStart - navigation_start,
      response_end: timing.responseEnd - navigation_start,
    };
  });

  return {
    tab_id: resolved_tab_id,
    metrics,
  };
}

async function execute_browser_drag(args, tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);
  const from_target = await resolve_required_selector_target(
    {
      selector: args?.fromSelector,
      element_ref: args?.fromElementRef,
    },
    resolved_tab_id,
    "browser_drag",
  );
  const to_target = await resolve_required_selector_target(
    {
      selector: args?.toSelector,
      element_ref: args?.toElementRef,
    },
    resolved_tab_id,
    "browser_drag",
  );
  const from_point = await get_selector_center(resolved_tab_id, from_target.selector);
  const to_point = await get_selector_center(resolved_tab_id, to_target.selector);

  await dispatch_mouse_event(resolved_tab_id, "mouseMoved", from_point.x, from_point.y, "left", 1, 0);
  await dispatch_mouse_event(resolved_tab_id, "mousePressed", from_point.x, from_point.y, "left", 1, 1);
  await dispatch_mouse_event(resolved_tab_id, "mouseMoved", to_point.x, to_point.y, "left", 1, 1);
  await dispatch_mouse_event(resolved_tab_id, "mouseReleased", to_point.x, to_point.y, "left", 1, 0);

  return {
    tab_id: resolved_tab_id,
    ok: true,
    from_selector: from_target.selector,
    from_element_ref: from_target.element_ref,
    to_selector: to_target.selector,
    to_element_ref: to_target.element_ref,
  };
}

async function attach_to_tab(tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);

  if (attached_tab_ids.has(resolved_tab_id)) {
    return;
  }

  network_requests_by_tab.set(resolved_tab_id, new Map());
  console_messages_by_tab.set(resolved_tab_id, []);
  reset_element_refs_for_tab(resolved_tab_id);

  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId: resolved_tab_id }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      attached_tab_ids.add(resolved_tab_id);
      resolve(undefined);
    });
  });

  try {
    await send_debugger_command(resolved_tab_id, "Network.enable", {});
    await send_debugger_command(resolved_tab_id, "Runtime.enable", {});
    await send_debugger_command(resolved_tab_id, "DOM.enable", {});
    await send_debugger_command(resolved_tab_id, "CSS.enable", {});
  } catch (error) {
    log_warn("debugger domain enable failed", error);
  }
}

async function detach_from_tab(tab_id) {
  const resolved_tab_id = assert_tab_id(tab_id);

  if (!attached_tab_ids.has(resolved_tab_id)) {
    return;
  }

  await new Promise((resolve, reject) => {
    chrome.debugger.detach({ tabId: resolved_tab_id }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      attached_tab_ids.delete(resolved_tab_id);
      network_requests_by_tab.delete(resolved_tab_id);
      console_messages_by_tab.delete(resolved_tab_id);
      element_refs_by_tab.delete(resolved_tab_id);
      resolve(undefined);
    });
  });
}

function send_response(request_id, agent_session_id, ok, result, error, error_code, error_details, retryable = false) {
  send_json({
    request_id,
    agent_session_id,
    ok,
    result,
    error,
    error_code,
    error_details,
    retryable,
  });
}

function send_json(payload) {
  if (!bridge_socket || bridge_socket.readyState !== WebSocket.OPEN) {
    return;
  }

  bridge_socket.send(JSON.stringify(payload));
}

function start_heartbeat() {
  stop_heartbeat();

  heartbeat_timer = setInterval(() => {
    send_json({ type: "heartbeat", ts: now() });
  }, 15000);
}

function stop_heartbeat() {
  if (heartbeat_timer) {
    clearInterval(heartbeat_timer);
    heartbeat_timer = null;
  }
}

function get_network_store(tab_id) {
  let store = network_requests_by_tab.get(tab_id);
  if (!store) {
    store = new Map();
    network_requests_by_tab.set(tab_id, store);
  }

  return store;
}

function prune_network_store(store, max_entries) {
  if (store.size <= max_entries) {
    return;
  }

  const rows = Array.from(store.entries());
  rows.sort((left, right) => Number(left[1]?.timestamp ?? 0) - Number(right[1]?.timestamp ?? 0));
  const remove_count = store.size - max_entries;

  for (let i = 0; i < remove_count; i += 1) {
    const key = rows[i]?.[0];
    if (typeof key === "string") {
      store.delete(key);
    }
  }
}

function push_console_message(tab_id, message) {
  let messages = console_messages_by_tab.get(tab_id);
  if (!messages) {
    messages = [];
    console_messages_by_tab.set(tab_id, messages);
  }

  messages.push(message);
  if (messages.length > 500) {
    messages.splice(0, messages.length - 500);
  }
}

function assert_tab_id(tab_id) {
  if (typeof tab_id !== "number" || !Number.isInteger(tab_id) || tab_id <= 0) {
    throw new Error("valid tab_id is required");
  }

  return tab_id;
}

async function execute_in_tab(tab_id, func, ...args) {
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab_id },
    func,
    args,
  });

  return result?.[0]?.result;
}

async function wait_for_tab_complete(tab_id, timeout_ms) {
  const tab = await chrome.tabs.get(tab_id);
  if (tab.status === "complete") {
    return;
  }

  await new Promise((resolve) => {
    let done = false;

    function finish() {
      if (done) {
        return;
      }

      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(undefined);
    }

    function listener(updated_tab_id, change_info) {
      if (updated_tab_id !== tab_id) {
        return;
      }

      if (change_info.status === "complete") {
        finish();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeout_ms);
  });
}

function sleep(timeout_ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeout_ms);
  });
}

async function send_debugger_command(tab_id, method, params) {
  return await new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: tab_id }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(result);
    });
  });
}

globalThis.local_mcp_extension_test_api = {
  attach_to_tab,
  detach_from_tab,
  execute_browser_snapshot,
  execute_browser_take_screenshot,
};

init().catch((error) => {
  log_error("fatal init error", error);
});
