import { generate_agent_session_id, now_iso_string } from "./id";
import { tool_error } from "./errors";
import type { agent_session, session_snapshot } from "./types";

function parse_session_timestamp_ms(iso_timestamp: string): number | undefined {
  const parsed = Date.parse(iso_timestamp);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return undefined;
}

function is_session_stale_for_cutoff(session: agent_session, stale_before_ms: number): boolean {
  if (typeof session.resource_reaped_at === "string" && session.resource_reaped_at.length > 0) {
    const resource_reaped_at_ms = parse_session_timestamp_ms(session.resource_reaped_at);
    if (typeof resource_reaped_at_ms === "number") {
      return false;
    }
  }

  const last_seen_at_ms = parse_session_timestamp_ms(session.last_seen_at);
  if (typeof last_seen_at_ms !== "number") {
    return false;
  }

  return last_seen_at_ms <= stale_before_ms;
}

function is_reaped_session_expired_for_cutoff(session: agent_session, stale_before_ms: number): boolean {
  if (typeof session.resource_reaped_at !== "string" || session.resource_reaped_at.length === 0) {
    return false;
  }

  const resource_reaped_at_ms = parse_session_timestamp_ms(session.resource_reaped_at);
  if (typeof resource_reaped_at_ms !== "number") {
    return false;
  }

  return resource_reaped_at_ms <= stale_before_ms;
}

export class session_registry {
  private readonly sessions_by_id: Map<string, agent_session>;

  public constructor() {
    this.sessions_by_id = new Map<string, agent_session>();
  }

  public create_session(client_name?: string, auth_mode: "none" | "token" = "none"): agent_session {
    let candidate = generate_agent_session_id(client_name);
    while (this.sessions_by_id.has(candidate)) {
      candidate = generate_agent_session_id(client_name);
    }

    const now = now_iso_string();
    const session: agent_session = {
      agent_session_id: candidate,
      client_name,
      connected_at: now,
      last_seen_at: now,
      state: "connected",
      auth_mode,
      owned_tab_ids: new Set<number>(),
    };

    this.sessions_by_id.set(candidate, session);
    return session;
  }

  public get_session(agent_session_id: string): agent_session {
    const session = this.sessions_by_id.get(agent_session_id);
    if (!session) {
      throw new tool_error("SESSION_NOT_FOUND", `unknown session: ${agent_session_id}`, false, {
        agent_session_id,
      });
    }

    return session;
  }

  public has_session(agent_session_id: string): boolean {
    return this.sessions_by_id.has(agent_session_id);
  }

  public touch_session(agent_session_id: string): void {
    const session = this.get_session(agent_session_id);
    session.last_seen_at = now_iso_string();
  }

  public mark_session_recovered(agent_session_id: string): void {
    const session = this.get_session(agent_session_id);
    session.last_seen_at = now_iso_string();
    delete session.resource_reaped_at;
  }

  public mark_tab_owned(agent_session_id: string, tab_id: number): void {
    const session = this.get_session(agent_session_id);
    session.owned_tab_ids.add(tab_id);
    session.last_seen_at = now_iso_string();
    delete session.resource_reaped_at;
  }

  public mark_tab_released(agent_session_id: string, tab_id: number): void {
    const session = this.get_session(agent_session_id);
    session.owned_tab_ids.delete(tab_id);
    session.last_seen_at = now_iso_string();
  }

  public close_session(agent_session_id: string): number[] {
    const session = this.get_session(agent_session_id);
    session.state = "disconnecting";
    session.last_seen_at = now_iso_string();

    const owned_tab_ids = [...session.owned_tab_ids];
    session.owned_tab_ids.clear();
    session.state = "disconnected";
    this.sessions_by_id.delete(agent_session_id);

    return owned_tab_ids;
  }

  public mark_resources_reaped(agent_session_id: string): number[] {
    const session = this.get_session(agent_session_id);
    const existing_reaped_at_ms =
      typeof session.resource_reaped_at === "string" ? parse_session_timestamp_ms(session.resource_reaped_at) : undefined;
    if (typeof existing_reaped_at_ms === "number") {
      return [];
    }

    const owned_tab_ids = [...session.owned_tab_ids];
    session.owned_tab_ids.clear();
    session.resource_reaped_at = now_iso_string();
    return owned_tab_ids;
  }

  public list_active_sessions(): string[] {
    return [...this.sessions_by_id.keys()];
  }

  public list_stale_session_ids(timeout_minutes: number, now_ms = Date.now()): string[] {
    if (!Number.isFinite(timeout_minutes) || timeout_minutes <= 0) {
      return [];
    }

    const stale_before_ms = now_ms - timeout_minutes * 60_000;
    const stale_session_ids: string[] = [];

    for (const session of this.sessions_by_id.values()) {
      if (!is_session_stale_for_cutoff(session, stale_before_ms)) {
        continue;
      }

      stale_session_ids.push(session.agent_session_id);
    }

    stale_session_ids.sort((left, right) => left.localeCompare(right));
    return stale_session_ids;
  }

  public is_session_stale(agent_session_id: string, timeout_minutes: number, now_ms = Date.now()): boolean {
    if (!Number.isFinite(timeout_minutes) || timeout_minutes <= 0) {
      return false;
    }

    const session = this.sessions_by_id.get(agent_session_id);
    if (!session) {
      return false;
    }

    const stale_before_ms = now_ms - timeout_minutes * 60_000;
    return is_session_stale_for_cutoff(session, stale_before_ms);
  }

  public list_expired_reaped_session_ids(timeout_minutes: number, now_ms = Date.now()): string[] {
    if (!Number.isFinite(timeout_minutes) || timeout_minutes <= 0) {
      return [];
    }

    const stale_before_ms = now_ms - timeout_minutes * 60_000;
    const expired_session_ids: string[] = [];

    for (const session of this.sessions_by_id.values()) {
      if (!is_reaped_session_expired_for_cutoff(session, stale_before_ms)) {
        continue;
      }

      expired_session_ids.push(session.agent_session_id);
    }

    expired_session_ids.sort((left, right) => left.localeCompare(right));
    return expired_session_ids;
  }

  public is_reaped_session_expired(agent_session_id: string, timeout_minutes: number, now_ms = Date.now()): boolean {
    if (!Number.isFinite(timeout_minutes) || timeout_minutes <= 0) {
      return false;
    }

    const session = this.sessions_by_id.get(agent_session_id);
    if (!session) {
      return false;
    }

    const stale_before_ms = now_ms - timeout_minutes * 60_000;
    return is_reaped_session_expired_for_cutoff(session, stale_before_ms);
  }

  public list_session_snapshots(): session_snapshot[] {
    const snapshots: session_snapshot[] = [];

    for (const session of this.sessions_by_id.values()) {
      const snapshot: session_snapshot = {
        agent_session_id: session.agent_session_id,
        client_name: session.client_name,
        connected_at: session.connected_at,
        last_seen_at: session.last_seen_at,
        state: session.state,
        owned_tab_ids: [...session.owned_tab_ids].sort((left, right) => left - right),
      };

      if (typeof session.resource_reaped_at === "string") {
        snapshot.resource_reaped_at = session.resource_reaped_at;
      }

      snapshots.push(snapshot);
    }

    snapshots.sort((left, right) => left.agent_session_id.localeCompare(right.agent_session_id));
    return snapshots;
  }
}
