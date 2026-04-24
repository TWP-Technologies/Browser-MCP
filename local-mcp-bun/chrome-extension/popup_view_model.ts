// Modified by [KnotFalse]

export interface toggle_intent_state {
  extension_enabled: boolean;
  executing_target_enabled: boolean | null;
  queued_target_enabled: boolean | null;
}

export interface cleanup_session_state {
  last_seen_at: string;
  resource_reaped_at?: string;
}

function pad_2(value: number): string {
  return String(value).padStart(2, "0");
}

function format_meridiem_hour(hours_24: number): { hour_12: number; meridiem: string } {
  const meridiem = hours_24 >= 12 ? "PM" : "AM";
  const hour_12 = hours_24 % 12 === 0 ? 12 : hours_24 % 12;
  return { hour_12, meridiem };
}

function is_same_local_day(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
  );
}

export function resolve_toggle_reference_enabled(state: toggle_intent_state): boolean {
  if (typeof state.queued_target_enabled === "boolean") {
    return state.queued_target_enabled;
  }

  if (typeof state.executing_target_enabled === "boolean") {
    return state.executing_target_enabled;
  }

  return state.extension_enabled;
}

export function compute_next_toggle_target_enabled(state: toggle_intent_state): boolean {
  return !resolve_toggle_reference_enabled(state);
}

export function format_snapshot_badge_timestamp(iso_timestamp: string | undefined, now_ms = Date.now()): string {
  if (typeof iso_timestamp !== "string" || iso_timestamp.length === 0) {
    return "-";
  }

  const parsed = new Date(iso_timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }

  const now = new Date(now_ms);
  const { hour_12, meridiem } = format_meridiem_hour(parsed.getHours());
  const minute = pad_2(parsed.getMinutes());

  if (is_same_local_day(parsed, now)) {
    const second = pad_2(parsed.getSeconds());
    return `${hour_12}:${minute}:${second} ${meridiem}`;
  }

  const month = parsed.getMonth() + 1;
  const day = parsed.getDate();
  return `${month}/${day} ${hour_12}:${minute} ${meridiem}`;
}

export function format_cleanup_chip_label(stale_session_timeout_minutes: number): string {
  if (!Number.isFinite(stale_session_timeout_minutes) || stale_session_timeout_minutes <= 0) {
    return "Auto-cleanup Off";
  }

  return `Auto-cleanup ${stale_session_timeout_minutes}m`;
}

export function has_valid_resource_reaped_at(session: cleanup_session_state): boolean {
  if (typeof session.resource_reaped_at !== "string" || session.resource_reaped_at.length === 0) {
    return false;
  }

  return Number.isFinite(Date.parse(session.resource_reaped_at));
}

export function is_session_overdue(
  session: cleanup_session_state,
  stale_session_timeout_minutes: number,
  now_ms = Date.now(),
): boolean {
  if (!Number.isFinite(stale_session_timeout_minutes) || stale_session_timeout_minutes <= 0) {
    return false;
  }

  if (has_valid_resource_reaped_at(session)) {
    return false;
  }

  const parsed_last_seen_at = Date.parse(session.last_seen_at);
  if (!Number.isFinite(parsed_last_seen_at)) {
    return false;
  }

  return parsed_last_seen_at <= now_ms - stale_session_timeout_minutes * 60_000;
}

export function count_overdue_sessions(
  sessions: cleanup_session_state[],
  stale_session_timeout_minutes: number,
  now_ms = Date.now(),
): number {
  return sessions.filter((session) => is_session_overdue(session, stale_session_timeout_minutes, now_ms)).length;
}
