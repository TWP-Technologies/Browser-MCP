import { generate_agent_session_id, now_iso_string } from "./id";
import { tool_error } from "./errors";
import type { agent_session } from "./types";

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

  public touch_session(agent_session_id: string): void {
    const session = this.get_session(agent_session_id);
    session.last_seen_at = now_iso_string();
  }

  public mark_tab_owned(agent_session_id: string, tab_id: number): void {
    const session = this.get_session(agent_session_id);
    session.owned_tab_ids.add(tab_id);
    session.last_seen_at = now_iso_string();
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

  public list_active_sessions(): string[] {
    return [...this.sessions_by_id.keys()];
  }
}
