import { expect, test } from "bun:test";
import { tab_lock_manager } from "../../src/tab_lock_manager";
import { tool_error } from "../../src/errors";

test("tab_lock_manager acquires and releases lock", async () => {
  const manager = new tab_lock_manager();
  const lock = await manager.acquire_lock(11, "session-a");

  expect(lock.owner_agent_session_id).toBe("session-a");
  expect(manager.get_lock(11)?.owner_agent_session_id).toBe("session-a");

  manager.release_lock(11, "session-a");
  expect(manager.get_lock(11)).toBeUndefined();
});

test("tab_lock_manager returns LOCK_CONFLICT on fail-fast contention", async () => {
  const manager = new tab_lock_manager();
  await manager.acquire_lock(12, "session-a");

  try {
    await manager.acquire_lock(12, "session-b");
    throw new Error("expected lock conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("LOCK_CONFLICT");
  }
});

test("tab_lock_manager transfers lock to waiter when owner releases", async () => {
  const manager = new tab_lock_manager();
  await manager.acquire_lock(13, "session-a");

  const waiter = manager.acquire_lock(13, "session-b", 500);
  manager.release_lock(13, "session-a");

  const lock = await waiter;
  expect(lock.owner_agent_session_id).toBe("session-b");
});

test("tab_lock_manager cancels queued waiters by owner", async () => {
  const manager = new tab_lock_manager();
  await manager.acquire_lock(14, "session-a");

  const waiter = manager.acquire_lock(14, "session-b", 500);
  const cancelled_tab_ids = manager.cancel_waiters_by_owner("session-b");
  expect(cancelled_tab_ids).toEqual([14]);

  try {
    await waiter;
    throw new Error("expected waiter cancellation");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("SESSION_NOT_FOUND");
  }
});


test("tab_lock_manager can release all locks by owner", async () => {
  const manager = new tab_lock_manager();
  await manager.acquire_lock(21, "session-a");
  await manager.acquire_lock(22, "session-a");
  await manager.acquire_lock(23, "session-b");

  const released = manager.release_locks_by_owner("session-a");
  expect(released.sort((left, right) => left - right)).toEqual([21, 22]);
  expect(manager.get_lock(21)).toBeUndefined();
  expect(manager.get_lock(22)).toBeUndefined();
  expect(manager.get_lock(23)?.owner_agent_session_id).toBe("session-b");
});
