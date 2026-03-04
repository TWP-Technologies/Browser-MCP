// Modified by [KnotFalse]

export interface toggle_intent_state {
  extension_enabled: boolean;
  executing_target_enabled: boolean | null;
  queued_target_enabled: boolean | null;
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
