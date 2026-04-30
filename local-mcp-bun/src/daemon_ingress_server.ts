// Modified by [KnotFalse]
import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolve_artifact_root, resolve_default_artifact_root, type artifact_root_context_input } from "./artifacts";
import { is_loopback_host } from "./config";
import { mcp_protocol_session, server_info } from "./mcp_protocol_session";
import { local_mcp_runtime } from "./runtime";

interface ingress_ws_data {
  connection_id: number;
  connected_at: string;
  artifact_root_context: artifact_root_context_input;
}

interface closeable_socket {
  close: (code?: number, reason?: string) => void;
}

function token_equals(left: string, right: string): boolean {
  const left_buffer = Buffer.from(left);
  const right_buffer = Buffer.from(right);
  return left_buffer.length === right_buffer.length && timingSafeEqual(left_buffer, right_buffer);
}

export interface daemon_health_snapshot {
  service: "local-mcp-daemon";
  pid: number;
  started_at: string;
  updated_at: string;
  daemon_host: string;
  daemon_port: number;
  bridge_host: string;
  bridge_port: number;
  bridge_state: string;
  active_proxy_connections: number;
  active_sessions: number;
  auth_enabled: boolean;
  auth_token_hint?: string;
  daemon_state_path: string;
  server_version: string;
  stale_session_timeout_minutes: number;
}

interface daemon_ingress_server_options {
  runtime: local_mcp_runtime;
  daemon_host: string;
  daemon_port: number;
  bridge_host: string;
  bridge_port: number;
  daemon_state_path: string;
  idle_timeout_ms: number;
  auth_enabled: boolean;
  auth_token_hint?: string;
  artifact_root_token?: string;
  on_idle_timeout: () => Promise<void>;
  cleanup_interval_ms?: number;
  started_at?: string;
}

const default_cleanup_interval_ms = 60_000;

function resolve_cleanup_interval_ms(cleanup_interval_ms: number | undefined): number {
  if (typeof cleanup_interval_ms !== "number" || !Number.isInteger(cleanup_interval_ms) || cleanup_interval_ms <= 0) {
    return default_cleanup_interval_ms;
  }

  return cleanup_interval_ms;
}

export class daemon_ingress_server {
  private readonly runtime: local_mcp_runtime;
  private readonly daemon_host: string;
  private readonly daemon_port: number;
  private readonly daemon_state_path: string;
  private readonly bridge_host: string;
  private readonly bridge_port: number;
  private readonly idle_timeout_ms: number;
  private readonly cleanup_interval_ms: number;
  private readonly auth_enabled: boolean;
  private readonly auth_token_hint?: string;
  private readonly artifact_root_token?: string;
  private readonly on_idle_timeout: () => Promise<void>;
  private readonly sessions_by_connection_id: Map<number, mcp_protocol_session>;
  private readonly sockets_by_connection_id: Map<number, closeable_socket>;
  private readonly agent_session_id_by_connection_id: Map<number, string>;
  private readonly connection_id_by_agent_session_id: Map<string, number>;
  private readonly last_activity_at_ms_by_connection_id: Map<number, number>;
  private readonly started_at: string;
  private next_connection_id: number;
  private server: Bun.Server<ingress_ws_data>;
  private idle_timer: ReturnType<typeof setTimeout> | undefined;
  private cleanup_timer: ReturnType<typeof setInterval> | undefined;
  private cleanup_in_progress: boolean;
  private stopping: boolean;

  public constructor(options: daemon_ingress_server_options) {
    this.runtime = options.runtime;
    this.daemon_host = options.daemon_host;
    this.daemon_port = options.daemon_port;
    this.bridge_host = options.bridge_host;
    this.bridge_port = options.bridge_port;
    this.daemon_state_path = options.daemon_state_path;
    this.idle_timeout_ms = options.idle_timeout_ms;
    this.cleanup_interval_ms = resolve_cleanup_interval_ms(options.cleanup_interval_ms);
    this.auth_enabled = options.auth_enabled;
    this.auth_token_hint = options.auth_token_hint;
    this.artifact_root_token = options.artifact_root_token;
    this.on_idle_timeout = options.on_idle_timeout;
    this.sessions_by_connection_id = new Map<number, mcp_protocol_session>();
    this.sockets_by_connection_id = new Map<number, closeable_socket>();
    this.agent_session_id_by_connection_id = new Map<number, string>();
    this.connection_id_by_agent_session_id = new Map<string, number>();
    this.last_activity_at_ms_by_connection_id = new Map<number, number>();
    this.started_at = options.started_at ?? new Date().toISOString();
    this.next_connection_id = 1;
    this.cleanup_in_progress = false;
    this.stopping = false;

    this.server = Bun.serve<ingress_ws_data>({
      hostname: this.daemon_host,
      port: this.daemon_port,
      fetch: (request, server_instance) => this.handle_fetch(request, server_instance),
      websocket: {
        open: (socket) => this.handle_socket_open(socket),
        message: (socket, message) => this.handle_socket_message(socket, message),
        close: (socket) => {
          void this.handle_socket_close(socket).catch((error) => {
            console.error("[daemon-ingress] socket close cleanup failed", error);
          });
        },
        error: (socket) => {
          void this.handle_socket_close(socket).catch((error) => {
            console.error("[daemon-ingress] socket error cleanup failed", error);
          });
        },
      },
    });

    this.cleanup_timer = setInterval(() => {
      if (this.cleanup_in_progress) {
        return;
      }

      this.cleanup_in_progress = true;
      void this.run_cleanup_tick()
        .catch((error) => {
          console.error("[daemon-ingress] cleanup tick failed", error);
        })
        .finally(() => {
          this.cleanup_in_progress = false;
        });
    }, this.cleanup_interval_ms);
  }

  public get_health_snapshot(): daemon_health_snapshot {
    return {
      service: "local-mcp-daemon",
      pid: process.pid,
      started_at: this.started_at,
      updated_at: new Date().toISOString(),
      daemon_host: this.daemon_host,
      daemon_port: this.daemon_port,
      bridge_host: this.bridge_host,
      bridge_port: this.bridge_port,
      bridge_state: this.runtime.bridge_transport.get_state(),
      active_proxy_connections: this.sessions_by_connection_id.size,
      active_sessions: this.runtime.session_registry.list_active_sessions().length,
      auth_enabled: this.auth_enabled,
      auth_token_hint: this.auth_token_hint,
      daemon_state_path: this.daemon_state_path,
      server_version: server_info.version,
      stale_session_timeout_minutes: this.runtime.tool_router.get_stale_session_timeout_minutes(),
    };
  }

  public async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.clear_idle_timer();
    this.clear_cleanup_timer();
    this.server.stop(true);

    for (const session of this.sessions_by_connection_id.values()) {
      await session.close().catch(() => {
        // best-effort session cleanup
      });
    }

    this.sessions_by_connection_id.clear();
    this.sockets_by_connection_id.clear();
    this.agent_session_id_by_connection_id.clear();
    this.connection_id_by_agent_session_id.clear();
    this.last_activity_at_ms_by_connection_id.clear();
  }

  private handle_fetch(request: Request, server_instance: Bun.Server<ingress_ws_data>): Response {
    const request_url = new URL(request.url);

    if (request_url.pathname === "/health") {
      return Response.json(this.get_health_snapshot(), { status: 200 });
    }

    if (request_url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }

    let artifact_root_context: artifact_root_context_input;
    try {
      artifact_root_context = this.resolve_connection_artifact_root(request_url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 400 });
    }

    const connection_id = this.next_connection_id;
    this.next_connection_id += 1;
    const upgraded = server_instance.upgrade(request, {
      data: {
        connection_id,
        connected_at: new Date().toISOString(),
        artifact_root_context,
      },
    });

    if (!upgraded) {
      return new Response("upgrade failed", { status: 500 });
    }

    return new Response(null, { status: 101 });
  }

  private handle_socket_open(socket: ServerWebSocket<ingress_ws_data>): void {
    this.clear_idle_timer();
    const connection_id = socket.data.connection_id;
    const session = new mcp_protocol_session({
      runtime: this.runtime,
      artifact_root_context: socket.data.artifact_root_context,
      on_agent_session_bound: (agent_session_id) => {
        this.bind_agent_session_to_connection(connection_id, agent_session_id);
      },
      on_agent_session_released: (agent_session_id) => {
        this.unbind_agent_session_from_connection(connection_id, agent_session_id);
      },
      write_response: (response) => {
        if (!this.sessions_by_connection_id.has(connection_id)) {
          return;
        }

        socket.send(JSON.stringify(response));
      },
    });

    this.sessions_by_connection_id.set(connection_id, session);
    this.sockets_by_connection_id.set(connection_id, socket);
    this.last_activity_at_ms_by_connection_id.set(connection_id, Date.now());
  }

  private resolve_connection_artifact_root(request_url: URL): artifact_root_context_input {
    if (!request_url.searchParams.has("client_artifact_root")) {
      return resolve_default_artifact_root();
    }

    const raw_artifact_root = request_url.searchParams.get("client_artifact_root")?.trim() ?? "";
    const raw_artifact_root_token = request_url.searchParams.get("client_artifact_root_token")?.trim() ?? "";
    if (!this.artifact_root_token || !token_equals(raw_artifact_root_token, this.artifact_root_token)) {
      throw new Error("client_artifact_root requires a daemon-issued artifact root token");
    }

    if (raw_artifact_root.length === 0) {
      throw new Error("client_artifact_root must be a non-empty absolute path");
    }

    if (!isAbsolute(raw_artifact_root)) {
      throw new Error("client_artifact_root must be an absolute path");
    }

    // A TCP daemon cannot infer a peer process cwd. Loopback proxy mode is the local trust boundary;
    // network-facing daemon ingress must enable MCP auth before honoring client-supplied roots.
    if (!is_loopback_host(this.daemon_host) && !this.auth_enabled) {
      throw new Error("client_artifact_root requires loopback daemon ingress or MCP auth");
    }

    if (!is_loopback_host(this.daemon_host)) {
      return () => resolve_artifact_root(raw_artifact_root);
    }

    return resolve_artifact_root(raw_artifact_root);
  }

  private handle_socket_message(
    socket: ServerWebSocket<ingress_ws_data>,
    message: string | Buffer | Uint8Array,
  ): void {
    const connection_id = socket.data.connection_id;
    const session = this.sessions_by_connection_id.get(connection_id);
    this.last_activity_at_ms_by_connection_id.set(connection_id, Date.now());
    if (!session) {
      return;
    }

    const raw_text = message.toString();
    const lines = raw_text.split("\n");
    for (const raw_line of lines) {
      const line = raw_line.trim();
      if (line.length === 0) {
        continue;
      }

      void session.handle_line(line).catch((error) => {
        console.error("[daemon-ingress] session handling failed", error);
      });
    }
  }

  private async handle_socket_close(socket: ServerWebSocket<ingress_ws_data>): Promise<void> {
    const connection_id = socket.data.connection_id;
    const session = this.sessions_by_connection_id.get(connection_id);
    if (!session) {
      return;
    }

    this.unbind_agent_session_from_connection(connection_id);
    this.sessions_by_connection_id.delete(connection_id);
    this.sockets_by_connection_id.delete(connection_id);
    this.last_activity_at_ms_by_connection_id.delete(connection_id);
    await session.close().catch(() => {
      // best-effort cleanup for closed sockets
    });

    if (this.sessions_by_connection_id.size === 0 && !this.stopping) {
      this.schedule_idle_timeout();
    }
  }

  private schedule_idle_timeout(): void {
    this.clear_idle_timer();
    this.idle_timer = setTimeout(() => {
      void this.on_idle_timeout().catch((error) => {
        console.error("[daemon-ingress] idle timeout handler failed", error);
      });
    }, this.idle_timeout_ms);
  }

  private clear_idle_timer(): void {
    if (!this.idle_timer) {
      return;
    }

    clearTimeout(this.idle_timer);
    this.idle_timer = undefined;
  }

  private bind_agent_session_to_connection(connection_id: number, agent_session_id: string): void {
    const previous_connection_id = this.connection_id_by_agent_session_id.get(agent_session_id);
    if (typeof previous_connection_id === "number" && previous_connection_id !== connection_id) {
      this.unbind_agent_session_from_connection(previous_connection_id, agent_session_id);
    }

    this.unbind_agent_session_from_connection(connection_id);
    this.agent_session_id_by_connection_id.set(connection_id, agent_session_id);
    this.connection_id_by_agent_session_id.set(agent_session_id, connection_id);
  }

  private unbind_agent_session_from_connection(connection_id: number, agent_session_id?: string): void {
    const bound_agent_session_id = this.agent_session_id_by_connection_id.get(connection_id);
    const resolved_agent_session_id = agent_session_id ?? bound_agent_session_id;
    if (typeof resolved_agent_session_id === "string") {
      const mapped_connection_id = this.connection_id_by_agent_session_id.get(resolved_agent_session_id);
      if (mapped_connection_id === connection_id) {
        this.connection_id_by_agent_session_id.delete(resolved_agent_session_id);
      }
    }

    if (!bound_agent_session_id) {
      return;
    }

    if (!agent_session_id || bound_agent_session_id === agent_session_id) {
      this.agent_session_id_by_connection_id.delete(connection_id);
    }
  }

  private async run_cleanup_tick(): Promise<void> {
    if (this.stopping) {
      return;
    }

    const cleanup_result = await this.runtime.tool_router.run_stale_session_cleanup();
    if (this.stopping) {
      return;
    }

    const freshly_unbound_connection_ids = this.unbind_connections_for_missing_sessions();
    this.close_stale_unbound_connections(cleanup_result.stale_session_timeout_minutes, freshly_unbound_connection_ids);
  }

  private close_stale_unbound_connections(
    stale_session_timeout_minutes: number,
    skipped_connection_ids = new Set<number>(),
  ): void {
    if (stale_session_timeout_minutes <= 0) {
      return;
    }

    const stale_before_ms = Date.now() - stale_session_timeout_minutes * 60_000;
    for (const [connection_id, last_activity_at_ms] of this.last_activity_at_ms_by_connection_id.entries()) {
      if (skipped_connection_ids.has(connection_id)) {
        continue;
      }

      if (this.agent_session_id_by_connection_id.has(connection_id)) {
        continue;
      }

      if (last_activity_at_ms > stale_before_ms) {
        continue;
      }

      const session = this.sessions_by_connection_id.get(connection_id);
      if (session?.has_recoverable_initialized_state()) {
        continue;
      }

      const socket = this.sockets_by_connection_id.get(connection_id);
      socket?.close(1000, "stale_connection_timeout");
    }
  }

  private unbind_connections_for_missing_sessions(): Set<number> {
    const unbound_connection_ids = new Set<number>();
    const unbound_at_ms = Date.now();

    for (const [connection_id, agent_session_id] of this.agent_session_id_by_connection_id.entries()) {
      if (this.runtime.session_registry.has_session(agent_session_id)) {
        continue;
      }

      this.unbind_agent_session_from_connection(connection_id, agent_session_id);
      this.last_activity_at_ms_by_connection_id.set(connection_id, unbound_at_ms);
      unbound_connection_ids.add(connection_id);
    }

    return unbound_connection_ids;
  }

  private clear_cleanup_timer(): void {
    if (!this.cleanup_timer) {
      return;
    }

    clearInterval(this.cleanup_timer);
    this.cleanup_timer = undefined;
  }
}
