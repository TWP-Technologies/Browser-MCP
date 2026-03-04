import { describe, expect, test } from "bun:test";
import {
  compute_next_toggle_target_enabled,
  format_snapshot_badge_timestamp,
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
