// Modified by [KnotFalse]
import { resolve as resolve_path } from "node:path";
import { is_loopback_host } from "./config";

interface stdio_proxy_server_options {
  daemon_url: string;
  connect_timeout_ms: number;
  attach_client_artifact_root?: boolean;
  artifact_root_token?: string;
}

function should_attach_client_artifact_root(daemon_url: string, configured?: boolean): boolean {
  if (typeof configured === "boolean") {
    return configured;
  }

  const url = new URL(daemon_url);
  return is_loopback_host(url.hostname);
}

function resolve_current_working_directory(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

export function build_daemon_url_with_client_artifact_root(
  daemon_url: string,
  artifact_root?: string,
  attach_client_artifact_root?: boolean,
  artifact_root_token?: string,
): string {
  const url = new URL(daemon_url);
  const attach_artifact_root = should_attach_client_artifact_root(daemon_url, attach_client_artifact_root);
  if (!attach_artifact_root) {
    url.searchParams.delete("client_artifact_root");
    url.searchParams.delete("client_artifact_root_token");
    return url.toString();
  }

  const has_client_artifact_root = url.searchParams.has("client_artifact_root");

  if (!has_client_artifact_root) {
    const resolved_artifact_root = artifact_root ?? resolve_current_working_directory();
    if (!resolved_artifact_root) {
      url.searchParams.delete("client_artifact_root_token");
      return url.toString();
    }

    url.searchParams.set("client_artifact_root", resolve_path(resolved_artifact_root));
  }

  if (artifact_root_token) {
    url.searchParams.set("client_artifact_root_token", artifact_root_token);
  }

  return url.toString();
}

export function redact_daemon_url_for_logs(daemon_url: string): string {
  const url = new URL(daemon_url);
  if (url.searchParams.has("client_artifact_root")) {
    url.searchParams.set("client_artifact_root", "<redacted>");
  }

  if (url.searchParams.has("client_artifact_root_token")) {
    url.searchParams.set("client_artifact_root_token", "<redacted>");
  }

  return url.toString();
}

function is_graceful_daemon_close_reason(reason: string): boolean {
  return reason === "stale_session_timeout" || reason === "stale_connection_timeout" || reason === "session_closed";
}

export class stdio_proxy_server {
  private readonly daemon_url: string;
  private readonly connect_timeout_ms: number;
  private socket: WebSocket | undefined;
  private line_buffer: string;
  private closing_intent: boolean;
  private stdin_ended: boolean;
  private exited: boolean;

  public constructor(options: stdio_proxy_server_options) {
    const artifact_root = resolve_current_working_directory();
    const should_attach_artifact_root = should_attach_client_artifact_root(
      options.daemon_url,
      options.attach_client_artifact_root,
    );
    const has_explicit_client_artifact_root = new URL(options.daemon_url).searchParams.has("client_artifact_root");
    const attach_client_artifact_root =
      should_attach_artifact_root && (typeof artifact_root === "string" || has_explicit_client_artifact_root);
    if (should_attach_artifact_root && !artifact_root && !has_explicit_client_artifact_root) {
      console.error("[daemon] client cwd unavailable; connecting without per-client artifact root metadata");
    }

    this.daemon_url = build_daemon_url_with_client_artifact_root(
      options.daemon_url,
      artifact_root,
      attach_client_artifact_root,
      options.artifact_root_token,
    );
    this.connect_timeout_ms = options.connect_timeout_ms;
    this.line_buffer = "";
    this.closing_intent = false;
    this.stdin_ended = false;
    this.exited = false;
  }

  public async start(): Promise<void> {
    this.socket = await this.connect();
    this.socket.addEventListener("message", (event) => {
      this.handle_daemon_message(event.data);
    });
    this.socket.addEventListener("close", (event) => {
      this.handle_daemon_close(event.reason || "socket closed");
    });
    this.socket.addEventListener("error", () => {
      this.handle_daemon_close("socket error");
    });

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => this.handle_stdin_chunk(chunk));
    process.stdin.on("end", () => {
      this.stdin_ended = true;
      this.closing_intent = true;

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.close(1000, "stdin_end");
        return;
      }

      this.exit_process(0);
    });
  }

  private async connect(): Promise<WebSocket> {
    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.daemon_url);
      const redacted_daemon_url = redact_daemon_url_for_logs(this.daemon_url);

      const timeout_id = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore timeout close race
        }
        reject(new Error(`timed out connecting to daemon ingress at ${redacted_daemon_url}`));
      }, this.connect_timeout_ms);

      socket.addEventListener("open", () => {
        clearTimeout(timeout_id);
        resolve(socket);
      });

      socket.addEventListener("error", () => {
        clearTimeout(timeout_id);
        reject(new Error(`failed to connect to daemon ingress at ${redacted_daemon_url}`));
      });
    });
  }

  private handle_stdin_chunk(chunk: string): void {
    this.line_buffer += chunk;

    while (true) {
      const line_break_index = this.line_buffer.indexOf("\n");
      if (line_break_index < 0) {
        return;
      }

      const line = this.line_buffer.slice(0, line_break_index).trim();
      this.line_buffer = this.line_buffer.slice(line_break_index + 1);
      if (line.length === 0) {
        continue;
      }

      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.handle_daemon_close("daemon ingress unavailable");
        return;
      }

      this.socket.send(line);
    }
  }

  private handle_daemon_message(payload: unknown): void {
    if (this.exited) {
      return;
    }

    if (typeof payload === "string") {
      this.write_stdout_lines(payload);
      return;
    }

    if (payload instanceof Uint8Array) {
      this.write_stdout_lines(new TextDecoder().decode(payload));
      return;
    }

    if (payload instanceof ArrayBuffer) {
      this.write_stdout_lines(new TextDecoder().decode(new Uint8Array(payload)));
      return;
    }
  }

  private write_stdout_lines(payload: string): void {
    const lines = payload.split("\n");
    for (const raw_line of lines) {
      const line = raw_line.trim();
      if (line.length === 0) {
        continue;
      }

      process.stdout.write(`${line}\n`);
    }
  }

  private handle_daemon_close(reason: string): void {
    if (this.exited) {
      return;
    }

    if (this.closing_intent || this.stdin_ended || is_graceful_daemon_close_reason(reason)) {
      this.exit_process(0);
      return;
    }

    console.error(`[daemon-proxy] connection closed: ${reason}`);
    this.exit_process(1);
  }

  private exit_process(exit_code: number): void {
    if (this.exited) {
      return;
    }

    this.exited = true;
    process.exit(exit_code);
  }
}
