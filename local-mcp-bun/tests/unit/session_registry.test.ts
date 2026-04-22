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

test("session_registry ignores sessions with invalid last_seen_at timestamps", () => {
  const registry = new session_registry();
  const invalid_session = registry.create_session("invalid");
  const stale_session = registry.create_session("stale");

  registry.get_session(invalid_session.agent_session_id).last_seen_at = "not-a-timestamp";
  registry.get_session(stale_session.agent_session_id).last_seen_at = new Date("2026-04-22T10:00:00.000Z").toISOString();

  const stale_session_ids = registry.list_stale_session_ids(120, new Date("2026-04-22T16:00:00.000Z").getTime());
  expect(stale_session_ids).toEqual([stale_session.agent_session_id]);
});
