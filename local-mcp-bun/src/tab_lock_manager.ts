import { now_iso_string } from "./id";
import { tool_error } from "./errors";
import type { tab_lock } from "./types";

interface lock_waiter {
  agent_session_id: string;
  resolve: (value: tab_lock) => void;
  reject: (reason: unknown) => void;
  timeout_id: Timer;
  wait_timeout_ms: number;
}

interface lock_record {
  lock: tab_lock;
  waiters: lock_waiter[];
}

function create_waiter_cancelled_error(agent_session_id: string, tab_id: number): tool_error {
  return new tool_error("SESSION_NOT_FOUND", `session closed while waiting for lock on tab ${tab_id}`, false, {
    agent_session_id,
    tab_id,
  });
}

export class tab_lock_manager {
  private readonly locks_by_tab_id: Map<number, lock_record>;

  public constructor() {
    this.locks_by_tab_id = new Map<number, lock_record>();
  }

  public get_lock(tab_id: number): tab_lock | undefined {
    const record = this.locks_by_tab_id.get(tab_id);
    return record?.lock;
  }

  public list_locks(): tab_lock[] {
    return [...this.locks_by_tab_id.values()].map((record) => record.lock);
  }

  public async acquire_lock(tab_id: number, agent_session_id: string, wait_timeout_ms?: number): Promise<tab_lock> {
    const existing_record = this.locks_by_tab_id.get(tab_id);

    if (!existing_record) {
      const lock: tab_lock = {
        tab_id,
        owner_agent_session_id: agent_session_id,
        lock_state: "pending_attach",
        lock_acquired_at: now_iso_string(),
      };

      this.locks_by_tab_id.set(tab_id, { lock, waiters: [] });
      return lock;
    }

    if (existing_record.lock.owner_agent_session_id === agent_session_id) {
      return existing_record.lock;
    }

    if (!wait_timeout_ms || wait_timeout_ms <= 0) {
      throw new tool_error("LOCK_CONFLICT", `tab ${tab_id} is locked by ${existing_record.lock.owner_agent_session_id}`, true, {
        tab_id,
        owner_agent_session_id: existing_record.lock.owner_agent_session_id,
      });
    }

    return await new Promise<tab_lock>((resolve, reject) => {
      const timeout_id = setTimeout(() => {
        this.remove_waiter(tab_id, agent_session_id);
        reject(
          new tool_error("TIMEOUT", `timed out waiting for lock on tab ${tab_id}`, true, {
            tab_id,
            wait_timeout_ms,
          }),
        );
      }, wait_timeout_ms);

      existing_record.waiters.push({
        agent_session_id,
        resolve,
        reject,
        timeout_id,
        wait_timeout_ms,
      });
    });
  }

  public set_lock_state(tab_id: number, lock_state: tab_lock["lock_state"]): void {
    const record = this.locks_by_tab_id.get(tab_id);
    if (!record) {
      return;
    }

    record.lock.lock_state = lock_state;
  }

  public release_lock(tab_id: number, agent_session_id?: string): tab_lock | undefined {
    const record = this.locks_by_tab_id.get(tab_id);

    if (!record) {
      return undefined;
    }

    if (agent_session_id && record.lock.owner_agent_session_id !== agent_session_id) {
      throw new tool_error("LOCK_NOT_OWNED", `session ${agent_session_id} does not own lock for tab ${tab_id}`, false, {
        tab_id,
        owner_agent_session_id: record.lock.owner_agent_session_id,
        agent_session_id,
      });
    }

    const next_waiter = record.waiters.shift();

    if (!next_waiter) {
      this.locks_by_tab_id.delete(tab_id);
      return undefined;
    }

    clearTimeout(next_waiter.timeout_id);

    const next_lock: tab_lock = {
      tab_id,
      owner_agent_session_id: next_waiter.agent_session_id,
      lock_state: "pending_attach",
      lock_acquired_at: now_iso_string(),
    };

    this.locks_by_tab_id.set(tab_id, { lock: next_lock, waiters: record.waiters });
    next_waiter.resolve(next_lock);

    return next_lock;
  }

  public release_locks_by_owner(agent_session_id: string): number[] {
    const released_tab_ids: number[] = [];

    for (const [tab_id, record] of this.locks_by_tab_id.entries()) {
      if (record.lock.owner_agent_session_id !== agent_session_id) {
        continue;
      }

      released_tab_ids.push(tab_id);
      this.release_lock(tab_id, agent_session_id);
    }

    return released_tab_ids;
  }

  public list_owned_tab_ids(agent_session_id: string): number[] {
    const owned_tab_ids: number[] = [];

    for (const [tab_id, record] of this.locks_by_tab_id.entries()) {
      if (record.lock.owner_agent_session_id !== agent_session_id) {
        continue;
      }

      owned_tab_ids.push(tab_id);
    }

    owned_tab_ids.sort((left, right) => left - right);
    return owned_tab_ids;
  }

  public cancel_waiters_by_owner(agent_session_id: string): number[] {
    const waiting_tab_ids: number[] = [];

    for (const [tab_id, record] of this.locks_by_tab_id.entries()) {
      const retained_waiters: lock_waiter[] = [];
      let removed_waiter = false;

      for (const waiter of record.waiters) {
        if (waiter.agent_session_id !== agent_session_id) {
          retained_waiters.push(waiter);
          continue;
        }

        removed_waiter = true;
        clearTimeout(waiter.timeout_id);
        waiter.reject(create_waiter_cancelled_error(agent_session_id, tab_id));
      }

      record.waiters = retained_waiters;
      if (removed_waiter) {
        waiting_tab_ids.push(tab_id);
      }
    }

    waiting_tab_ids.sort((left, right) => left - right);
    return waiting_tab_ids;
  }

  private remove_waiter(tab_id: number, agent_session_id: string): void {
    const record = this.locks_by_tab_id.get(tab_id);
    if (!record) {
      return;
    }

    record.waiters = record.waiters.filter((waiter) => waiter.agent_session_id !== agent_session_id);
  }
}
