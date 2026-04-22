import { mcp_protocol_session } from "./mcp_protocol_session";
import { local_mcp_runtime } from "./runtime";
import type { json_rpc_response } from "./types";

const direct_cleanup_interval_ms = 60_000;

export class mcp_stdio_server {
  private readonly runtime: local_mcp_runtime;
  private readonly protocol_session: mcp_protocol_session;
  private line_buffer: string;
  private cleanup_timer: ReturnType<typeof setInterval> | undefined;

  public constructor(runtime: local_mcp_runtime) {
    this.runtime = runtime;
    this.protocol_session = new mcp_protocol_session({
      runtime,
      write_response: (response) => this.write_response(response),
    });
    this.line_buffer = "";
  }

  public start(): void {
    process.stdin.setEncoding("utf8");
    this.cleanup_timer = setInterval(() => {
      void this.runtime.tool_router.run_stale_session_cleanup();
    }, direct_cleanup_interval_ms);
    process.stdin.on("data", (chunk) => this.handle_chunk(chunk));
    process.stdin.on("end", () => {
      this.clear_cleanup_timer();
      this.protocol_session
        .close()
        .catch(() => {
          // ignore cleanup errors
        })
        .finally(() => {
          this.runtime.stop().catch(() => {
            // ignore shutdown errors
          });
        });
    });
  }

  private handle_chunk(chunk: string): void {
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

      this.protocol_session.handle_line(line).catch((error) => {
        const generic_message = error instanceof Error ? error.message : "internal server error";
        this.write_response({
          jsonrpc: "2.0",
          id: "internal",
          error: {
            code: -32603,
            message: generic_message,
          },
        });
      });
    }
  }

  private write_response(response: json_rpc_response): void {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  private clear_cleanup_timer(): void {
    if (!this.cleanup_timer) {
      return;
    }

    clearInterval(this.cleanup_timer);
    this.cleanup_timer = undefined;
  }
}
