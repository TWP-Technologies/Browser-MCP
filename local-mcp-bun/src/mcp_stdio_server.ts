import { tool_error } from "./errors";
import { local_mcp_runtime } from "./runtime";
import type { json_rpc_request, json_rpc_response } from "./types";

export class mcp_stdio_server {
  private readonly runtime: local_mcp_runtime;
  private line_buffer: string;

  public constructor(runtime: local_mcp_runtime) {
    this.runtime = runtime;
    this.line_buffer = "";
  }

  public start(): void {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => this.handle_chunk(chunk));
    process.stdin.on("end", () => {
      this.runtime.stop().catch(() => {
        // ignore shutdown errors
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

      this.handle_line(line).catch((error) => {
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

  private async handle_line(line: string): Promise<void> {
    let request: json_rpc_request;

    try {
      request = JSON.parse(line) as json_rpc_request;
    } catch {
      this.write_response({
        jsonrpc: "2.0",
        id: "parse_error",
        error: {
          code: -32700,
          message: "invalid JSON",
        },
      });
      return;
    }

    const response = await this.dispatch_request(request);
    this.write_response(response);
  }

  private async dispatch_request(request: json_rpc_request): Promise<json_rpc_response> {
    try {
      if (request.method === "initialize") {
        const client_name = typeof request.params?.client_name === "string" ? request.params.client_name : undefined;
        const token = typeof request.params?.token === "string" ? request.params.token : undefined;
        const result = this.runtime.tool_router.open_session(client_name, token);
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocol_version: "local-mcp-bun-v2",
            ...result,
          },
        };
      }

      if (request.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            tools: this.runtime.tool_router.list_tools(),
          },
        };
      }

      if (request.method === "tools/call") {
        const agent_session_id = request.params?.agent_session_id;
        const tool_name = request.params?.name;
        const args = request.params?.arguments;

        if (typeof agent_session_id !== "string" || typeof tool_name !== "string") {
          throw new tool_error("INVALID_ARGUMENT", "tools/call requires agent_session_id and name", false);
        }

        const parsed_args = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const result = await this.runtime.tool_router.call_tool(agent_session_id, tool_name, parsed_args);

        return {
          jsonrpc: "2.0",
          id: request.id,
          result,
        };
      }

      if (request.method === "session/close") {
        const agent_session_id = request.params?.agent_session_id;
        if (typeof agent_session_id !== "string") {
          throw new tool_error("INVALID_ARGUMENT", "session/close requires agent_session_id", false);
        }

        const result = await this.runtime.tool_router.close_session(agent_session_id);
        return {
          jsonrpc: "2.0",
          id: request.id,
          result,
        };
      }

      if (request.method === "sessions/list") {
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            sessions: this.runtime.session_registry.list_active_sessions(),
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `unknown method: ${request.method}`,
        },
      };
    } catch (error) {
      if (error instanceof tool_error) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32001,
            message: error.message,
            data: error.to_payload(),
          },
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message,
        },
      };
    }
  }

  private write_response(response: json_rpc_response): void {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
