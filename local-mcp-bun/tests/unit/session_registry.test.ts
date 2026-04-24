// Modified by [KnotFalse]
import { expect, test } from "bun:test";
import { session_registry } from "../../src/session_registry";
import { tool_error } from "../../src/errors";

test("session_registry creates unique sessions and tracks ownership", () => {
  const registry = new session_registry();
  const first = registry.create_session("client-a");
  const second = registry.create_session("client-a");

  expect(first.agent_session_id).not.toBe(second.agent_session_id);

  registry.mark_tab_owned(first.agent_session_id, 101);
  registry.mark_tab_owned(first.agent_session_id, 202);
  const released = registry.close_session(first.agent_session_id);

  expect(released.sort((left, right) => left - right)).toEqual([101, 202]);
  expect(registry.list_active_sessions()).toEqual([second.agent_session_id]);
});

test("session_registry throws SESSION_NOT_FOUND for unknown session", () => {
  const registry = new session_registry();

  expect(() => registry.get_session("missing")).toThrow();

  try {
    registry.get_session("missing");
    throw new Error("expected error");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    const typed_error = error as tool_error;
    expect(typed_error.code).toBe("SESSION_NOT_FOUND");
  }
});

test("session_registry emits stable snapshots with owned tabs", () => {
  const registry = new session_registry();
  const alpha = registry.create_session("alpha");
  const beta = registry.create_session("beta");

  registry.mark_tab_owned(alpha.agent_session_id, 202);
  registry.mark_tab_owned(alpha.agent_session_id, 101);
  registry.mark_tab_owned(beta.agent_session_id, 303);

  const snapshots = registry.list_session_snapshots();
  expect(snapshots.length).toBe(2);

  const alpha_snapshot = snapshots.find((entry) => entry.agent_session_id === alpha.agent_session_id);
  const beta_snapshot = snapshots.find((entry) => entry.agent_session_id === beta.agent_session_id);

  expect(alpha_snapshot?.owned_tab_ids).toEqual([101, 202]);
  expect(beta_snapshot?.owned_tab_ids).toEqual([303]);
  expect("artifact_root" in (alpha as unknown as Record<string, unknown>)).toBe(false);
  expect("artifact_root_real" in (alpha as unknown as Record<string, unknown>)).toBe(false);
  expect("artifact_root" in (alpha_snapshot as unknown as Record<string, unknown>)).toBe(false);
  expect("artifact_root_real" in (alpha_snapshot as unknown as Record<string, unknown>)).toBe(false);
});

test("session_registry stores and returns artifact root context copies", () => {
  const registry = new session_registry();
  const artifact_root_context = {
    artifact_root: "/workspace-a",
    artifact_root_real: "/workspace-a",
  };
  const session = registry.create_session("artifact-context", "none", artifact_root_context);

  artifact_root_context.artifact_root = "/mutated-workspace";

  const stored_context = registry.get_session_artifact_root_context(session.agent_session_id);
  expect(stored_context).toEqual({
    artifact_root: "/workspace-a",
    artifact_root_real: "/workspace-a",
  });

  stored_context.artifact_root = "/returned-mutation";

  expect(registry.get_session_artifact_root_context(session.agent_session_id)).toEqual({
    artifact_root: "/workspace-a",
    artifact_root_real: "/workspace-a",
  });
});

test("session_registry lists stale sessions from last_seen_at", () => {
  const registry = new session_registry();
  const stale_session = registry.create_session("stale");
  const fresh_session = registry.create_session("fresh");

  registry.get_session(stale_session.agent_session_id).last_seen_at = new Date("2026-04-22T10:00:00.000Z").toISOString();
  registry.get_session(fresh_session.agent_session_id).last_seen_at = new Date("2026-04-22T15:30:00.000Z").toISOString();

  const stale_session_ids = registry.list_stale_session_ids(120, new Date("2026-04-22T16:00:00.000Z").getTime());
  expect(stale_session_ids).toEqual([stale_session.agent_session_id]);
});

test("session_registry checks single-session stale eligibility", () => {
  const registry = new session_registry();
  const stale_session = registry.create_session("stale");
  const fresh_session = registry.create_session("fresh");
  const invalid_session = registry.create_session("invalid");
  const reaped_session = registry.create_session("reaped");
  const invalid_reaped_session = registry.create_session("invalid-reaped");
  const now_ms = new Date("2026-04-22T16:00:00.000Z").getTime();

  registry.get_session(stale_session.agent_session_id).last_seen_at = new Date("2026-04-22T10:00:00.000Z").toISOString();
  registry.get_session(fresh_session.agent_session_id).last_seen_at = new Date("2026-04-22T15:30:00.000Z").toISOString();
  registry.get_session(invalid_session.agent_session_id).last_seen_at = "not-a-timestamp";
  registry.get_session(reaped_session.agent_session_id).last_seen_at = new Date("2026-04-22T10:00:00.000Z").toISOString();
  registry.get_session(reaped_session.agent_session_id).resource_reaped_at = new Date(
    "2026-04-22T10:05:00.000Z",
  ).toISOString();
  registry.get_session(invalid_reaped_session.agent_session_id).last_seen_at = new Date(
    "2026-04-22T10:00:00.000Z",
  ).toISOString();
  registry.get_session(invalid_reaped_session.agent_session_id).resource_reaped_at = "not-a-timestamp";

  expect(registry.is_session_stale(stale_session.agent_session_id, 120, now_ms)).toBe(true);
  expect(registry.is_session_stale(fresh_session.agent_session_id, 120, now_ms)).toBe(false);
  expect(registry.is_session_stale(invalid_session.agent_session_id, 120, now_ms)).toBe(false);
  expect(registry.is_session_stale(reaped_session.agent_session_id, 120, now_ms)).toBe(false);
  expect(registry.is_session_stale(invalid_reaped_session.agent_session_id, 120, now_ms)).toBe(true);
  expect(registry.is_session_stale("missing", 120, now_ms)).toBe(false);
  expect(registry.is_session_stale(stale_session.agent_session_id, 0, now_ms)).toBe(false);
});

test("session_registry marks resource-reaped sessions without closing them", () => {
  const registry = new session_registry();
  const session = registry.create_session("soft-reap");

  registry.mark_tab_owned(session.agent_session_id, 101);
  registry.get_session(session.agent_session_id).last_seen_at = new Date("2026-04-22T10:00:00.000Z").toISOString();

  const released_tab_ids = registry.mark_resources_reaped(session.agent_session_id);
  const stale_session_ids = registry.list_stale_session_ids(120, new Date("2026-04-22T16:00:00.000Z").getTime());
  const snapshot = registry.list_session_snapshots().find((entry) => entry.agent_session_id === session.agent_session_id);

  expect(released_tab_ids).toEqual([101]);
  expect(stale_session_ids).toEqual([]);
  expect(registry.list_active_sessions()).toEqual([session.agent_session_id]);
  expect(snapshot?.owned_tab_ids).toEqual([]);
  expect(typeof snapshot?.resource_reaped_at).toBe("string");

  registry.touch_session(session.agent_session_id);
  expect(typeof registry.list_session_snapshots()[0]?.resource_reaped_at).toBe("string");
  registry.mark_session_recovered(session.agent_session_id);
  expect(registry.list_session_snapshots()[0]?.resource_reaped_at).toBeUndefined();
});

test("session_registry preserves the first valid resource reap timestamp", () => {
  const registry = new session_registry();
  const session = registry.create_session("soft-reap");
  const original_reaped_at = new Date("2026-04-22T10:00:00.000Z").toISOString();

  registry.get_session(session.agent_session_id).resource_reaped_at = original_reaped_at;

  const released_tab_ids = registry.mark_resources_reaped(session.agent_session_id);
  const snapshot = registry.list_session_snapshots().find((entry) => entry.agent_session_id === session.agent_session_id);

  expect(released_tab_ids).toEqual([]);
  expect(snapshot?.resource_reaped_at).toBe(original_reaped_at);
});

test("session_registry lists resource-reaped sessions after one timeout grace window", () => {
  const registry = new session_registry();
  const expired_session = registry.create_session("expired-reaped");
  const recent_session = registry.create_session("recent-reaped");

  registry.get_session(expired_session.agent_session_id).resource_reaped_at = new Date(
    "2026-04-22T10:00:00.000Z",
  ).toISOString();
  registry.get_session(recent_session.agent_session_id).resource_reaped_at = new Date(
    "2026-04-22T15:30:00.000Z",
  ).toISOString();

  const expired_session_ids = registry.list_expired_reaped_session_ids(
    120,
    new Date("2026-04-22T16:00:00.000Z").getTime(),
  );
  expect(expired_session_ids).toEqual([expired_session.agent_session_id]);
});

test("session_registry checks single-session expired reaped eligibility", () => {
  const registry = new session_registry();
  const expired_session = registry.create_session("expired-reaped");
  const recent_session = registry.create_session("recent-reaped");
  const invalid_session = registry.create_session("invalid-reaped");
  const active_session = registry.create_session("active");
  const now_ms = new Date("2026-04-22T16:00:00.000Z").getTime();

  registry.get_session(expired_session.agent_session_id).resource_reaped_at = new Date(
    "2026-04-22T10:00:00.000Z",
  ).toISOString();
  registry.get_session(recent_session.agent_session_id).resource_reaped_at = new Date(
    "2026-04-22T15:30:00.000Z",
  ).toISOString();
  registry.get_session(invalid_session.agent_session_id).resource_reaped_at = "not-a-timestamp";
  registry.get_session(active_session.agent_session_id).last_seen_at = new Date("2026-04-22T10:00:00.000Z").toISOString();

  expect(registry.is_reaped_session_expired(expired_session.agent_session_id, 120, now_ms)).toBe(true);
  expect(registry.is_reaped_session_expired(recent_session.agent_session_id, 120, now_ms)).toBe(false);
  expect(registry.is_reaped_session_expired(invalid_session.agent_session_id, 120, now_ms)).toBe(false);
  expect(registry.is_reaped_session_expired(active_session.agent_session_id, 120, now_ms)).toBe(false);
  expect(registry.is_reaped_session_expired("missing", 120, now_ms)).toBe(false);
  expect(registry.is_reaped_session_expired(expired_session.agent_session_id, 0, now_ms)).toBe(false);
});

test("session_registry ignores resource-reaped sessions with invalid reap timestamps", () => {
  const registry = new session_registry();
  const invalid_session = registry.create_session("invalid-reaped");
  const expired_session = registry.create_session("expired-reaped");

  registry.get_session(invalid_session.agent_session_id).resource_reaped_at = "not-a-timestamp";
  registry.get_session(invalid_session.agent_session_id).last_seen_at = new Date("2026-04-22T10:00:00.000Z").toISOString();
  registry.get_session(expired_session.agent_session_id).resource_reaped_at = new Date(
    "2026-04-22T10:00:00.000Z",
  ).toISOString();

  const stale_session_ids = registry.list_stale_session_ids(120, new Date("2026-04-22T16:00:00.000Z").getTime());
  const expired_session_ids = registry.list_expired_reaped_session_ids(
    120,
    new Date("2026-04-22T16:00:00.000Z").getTime(),
  );
  expect(stale_session_ids).toEqual([invalid_session.agent_session_id]);
  expect(expired_session_ids).toEqual([expired_session.agent_session_id]);
});

test("session_registry ignores sessions with invalid last_seen_at timestamps", () => {
  const registry = new session_registry();
  const invalid_session = registry.create_session("invalid");
  const stale_session = registry.create_session("stale");

  registry.get_session(invalid_session.agent_session_id).last_seen_at = "not-a-timestamp";
  registry.get_session(stale_session.agent_session_id).last_seen_at = new Date("2026-04-22T10:00:00.000Z").toISOString();

  const stale_session_ids = registry.list_stale_session_ids(120, new Date("2026-04-22T16:00:00.000Z").getTime());
  expect(stale_session_ids).toEqual([stale_session.agent_session_id]);
});
