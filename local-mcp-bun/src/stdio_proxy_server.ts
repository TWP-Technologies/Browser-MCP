interface stdio_proxy_server_options {
  daemon_url: string;
  connect_timeout_ms: number;
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
    this.daemon_url = options.daemon_url;
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
    this.socket.addEventListener("close", () => {
      this.handle_daemon_close("socket closed");
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

      const timeout_id = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore timeout close race
        }
        reject(new Error(`timed out connecting to daemon ingress at ${this.daemon_url}`));
      }, this.connect_timeout_ms);

      socket.addEventListener("open", () => {
        clearTimeout(timeout_id);
        resolve(socket);
      });

      socket.addEventListener("error", () => {
        clearTimeout(timeout_id);
        reject(new Error(`failed to connect to daemon ingress at ${this.daemon_url}`));
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

    if (this.closing_intent || this.stdin_ended) {
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
