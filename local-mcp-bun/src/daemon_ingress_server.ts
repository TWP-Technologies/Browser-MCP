import { mcp_protocol_session, server_info } from "./mcp_protocol_session";
import { local_mcp_runtime } from "./runtime";

interface ingress_ws_data {
  connection_id: number;
  connected_at: string;
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
  auth_enabled: boolean;
  auth_token_hint?: string;
  daemon_state_path: string;
  server_version: string;
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
  on_idle_timeout: () => Promise<void>;
}

export class daemon_ingress_server {
  private readonly runtime: local_mcp_runtime;
  private readonly daemon_host: string;
  private readonly daemon_port: number;
  private readonly daemon_state_path: string;
  private readonly bridge_host: string;
  private readonly bridge_port: number;
  private readonly idle_timeout_ms: number;
  private readonly auth_enabled: boolean;
  private readonly auth_token_hint?: string;
  private readonly on_idle_timeout: () => Promise<void>;
  private readonly sessions_by_connection_id: Map<number, mcp_protocol_session>;
  private readonly started_at: string;
  private next_connection_id: number;
  private server: Bun.Server<ingress_ws_data>;
  private idle_timer: ReturnType<typeof setTimeout> | undefined;
  private stopping: boolean;

  public constructor(options: daemon_ingress_server_options) {
    this.runtime = options.runtime;
    this.daemon_host = options.daemon_host;
    this.daemon_port = options.daemon_port;
    this.bridge_host = options.bridge_host;
    this.bridge_port = options.bridge_port;
    this.daemon_state_path = options.daemon_state_path;
    this.idle_timeout_ms = options.idle_timeout_ms;
    this.auth_enabled = options.auth_enabled;
    this.auth_token_hint = options.auth_token_hint;
    this.on_idle_timeout = options.on_idle_timeout;
    this.sessions_by_connection_id = new Map<number, mcp_protocol_session>();
    this.started_at = new Date().toISOString();
    this.next_connection_id = 1;
    this.stopping = false;

    this.server = Bun.serve<ingress_ws_data>({
      hostname: this.daemon_host,
      port: this.daemon_port,
      fetch: (request, server_instance) => this.handle_fetch(request, server_instance),
      websocket: {
        open: (socket) => this.handle_socket_open(socket),
        message: (socket, message) => this.handle_socket_message(socket, message),
        close: (socket) => {
          void this.handle_socket_close(socket);
        },
        error: (socket) => {
          void this.handle_socket_close(socket);
        },
      },
    });
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
      auth_enabled: this.auth_enabled,
      auth_token_hint: this.auth_token_hint,
      daemon_state_path: this.daemon_state_path,
      server_version: server_info.version,
    };
  }

  public async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.clear_idle_timer();
    this.server.stop(true);

    for (const session of this.sessions_by_connection_id.values()) {
      await session.close().catch(() => {
        // best-effort session cleanup
      });
    }

    this.sessions_by_connection_id.clear();
  }

  private handle_fetch(request: Request, server_instance: Bun.Server<ingress_ws_data>): Response {
    const request_url = new URL(request.url);

    if (request_url.pathname === "/health") {
      return Response.json(this.get_health_snapshot(), { status: 200 });
    }

    if (request_url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }

    const connection_id = this.next_connection_id;
    this.next_connection_id += 1;
    const upgraded = server_instance.upgrade(request, {
      data: {
        connection_id,
        connected_at: new Date().toISOString(),
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
      write_response: (response) => {
        if (!this.sessions_by_connection_id.has(connection_id)) {
          return;
        }

        socket.send(JSON.stringify(response));
      },
    });

    this.sessions_by_connection_id.set(connection_id, session);
  }

  private handle_socket_message(
    socket: ServerWebSocket<ingress_ws_data>,
    message: string | Buffer | Uint8Array,
  ): void {
    const connection_id = socket.data.connection_id;
    const session = this.sessions_by_connection_id.get(connection_id);
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

      void session.handle_line(line);
    }
  }

  private async handle_socket_close(socket: ServerWebSocket<ingress_ws_data>): Promise<void> {
    const connection_id = socket.data.connection_id;
    const session = this.sessions_by_connection_id.get(connection_id);
    if (!session) {
      return;
    }

    this.sessions_by_connection_id.delete(connection_id);
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
      void this.on_idle_timeout();
    }, this.idle_timeout_ms);
  }

  private clear_idle_timer(): void {
    if (!this.idle_timer) {
      return;
    }

    clearTimeout(this.idle_timer);
    this.idle_timer = undefined;
  }
}
