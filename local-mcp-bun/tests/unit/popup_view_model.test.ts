import { describe, expect, test } from "bun:test";
import {
  count_overdue_sessions,
  compute_next_toggle_target_enabled,
  format_cleanup_chip_label,
  format_snapshot_badge_timestamp,
  has_valid_resource_reaped_at,
  is_session_overdue,
  resolve_toggle_reference_enabled,
} from "../../chrome-extension/popup_view_model";

describe("popup_view_model toggle intent resolution", () => {
  test("uses extension enabled state when no queued or executing target exists", () => {
    const reference_enabled = resolve_toggle_reference_enabled({
      extension_enabled: true,
      executing_target_enabled: null,
      queued_target_enabled: null,
    });

    expect(reference_enabled).toBe(true);
    expect(
      compute_next_toggle_target_enabled({
        extension_enabled: true,
        executing_target_enabled: null,
        queued_target_enabled: null,
      }),
    ).toBe(false);
  });

  test("uses executing target while a toggle request is in-flight", () => {
    const reference_enabled = resolve_toggle_reference_enabled({
      extension_enabled: true,
      executing_target_enabled: false,
      queued_target_enabled: null,
    });

    expect(reference_enabled).toBe(false);
    expect(
      compute_next_toggle_target_enabled({
        extension_enabled: true,
        executing_target_enabled: false,
        queued_target_enabled: null,
      }),
    ).toBe(true);
  });

  test("queued target overrides executing target for last-intent semantics", () => {
    const reference_enabled = resolve_toggle_reference_enabled({
      extension_enabled: true,
      executing_target_enabled: false,
      queued_target_enabled: true,
    });

    expect(reference_enabled).toBe(true);
    expect(
      compute_next_toggle_target_enabled({
        extension_enabled: true,
        executing_target_enabled: false,
        queued_target_enabled: true,
      }),
    ).toBe(false);
  });
});

describe("popup_view_model snapshot timestamp formatting", () => {
  test("formats same-day timestamps with seconds", () => {
    const now = new Date(2026, 2, 4, 13, 31, 20);
    const snapshot = new Date(2026, 2, 4, 1, 2, 3);

    expect(format_snapshot_badge_timestamp(snapshot.toISOString(), now.getTime())).toBe("1:02:03 AM");
  });

  test("formats different-day timestamps as compact month/day + time", () => {
    const now = new Date(2026, 2, 4, 13, 31, 20);
    const snapshot = new Date(2026, 2, 3, 23, 7, 3);

    expect(format_snapshot_badge_timestamp(snapshot.toISOString(), now.getTime())).toBe("3/3 11:07 PM");
  });

  test("returns hyphen for missing or invalid timestamps", () => {
    expect(format_snapshot_badge_timestamp(undefined)).toBe("-");
    expect(format_snapshot_badge_timestamp("not-a-date")).toBe("-");
  });
});

describe("popup_view_model cleanup helpers", () => {
  test("formats cleanup chip labels for enabled and disabled states", () => {
    expect(format_cleanup_chip_label(120)).toBe("Auto-cleanup 120m");
    expect(format_cleanup_chip_label(0)).toBe("Auto-cleanup Off");
  });

  test("detects overdue sessions from last_seen_at", () => {
    const now = new Date(2026, 3, 22, 16, 0, 0).getTime();
    expect(
      is_session_overdue(
        {
          last_seen_at: new Date(2026, 3, 22, 13, 30, 0).toISOString(),
        },
        120,
        now,
      ),
    ).toBe(true);
    expect(
      is_session_overdue(
        {
          last_seen_at: new Date(2026, 3, 22, 14, 30, 1).toISOString(),
        },
        120,
        now,
      ),
    ).toBe(false);
    expect(
      is_session_overdue(
        {
          last_seen_at: new Date(2026, 3, 22, 13, 30, 0).toISOString(),
          resource_reaped_at: new Date(2026, 3, 22, 15, 59, 0).toISOString(),
        },
        120,
        now,
      ),
    ).toBe(false);
    expect(
      is_session_overdue(
        {
          last_seen_at: new Date(2026, 3, 22, 13, 30, 0).toISOString(),
          resource_reaped_at: "not-a-timestamp",
        },
        120,
        now,
      ),
    ).toBe(true);
  });

  test("validates resource-reaped timestamps consistently", () => {
    expect(
      has_valid_resource_reaped_at({
        last_seen_at: new Date(2026, 3, 22, 13, 30, 0).toISOString(),
        resource_reaped_at: new Date(2026, 3, 22, 15, 59, 0).toISOString(),
      }),
    ).toBe(true);
    expect(
      has_valid_resource_reaped_at({
        last_seen_at: new Date(2026, 3, 22, 13, 30, 0).toISOString(),
        resource_reaped_at: "not-a-timestamp",
      }),
    ).toBe(false);
  });

  test("counts overdue sessions across the snapshot list", () => {
    const now = new Date(2026, 3, 22, 16, 0, 0).getTime();
    expect(
      count_overdue_sessions(
        [
          { last_seen_at: new Date(2026, 3, 22, 13, 30, 0).toISOString() },
          { last_seen_at: new Date(2026, 3, 22, 15, 0, 0).toISOString() },
          { last_seen_at: "invalid" },
        ],
        120,
        now,
      ),
    ).toBe(1);
  });
});
