import { tool_error } from "./errors";
import { local_mcp_runtime } from "./runtime";
import type { json_rpc_request, json_rpc_response } from "./types";

const default_mcp_protocol_version = "2024-11-05";
const local_protocol_version = "local-mcp-bun-v2";
const server_info = {
  name: "local-mcp",
  version: "0.1.1",
} as const;

export class mcp_stdio_server {
  private readonly runtime: local_mcp_runtime;
  private line_buffer: string;
  private initialized_agent_session_id: string | null;

  public constructor(runtime: local_mcp_runtime) {
    this.runtime = runtime;
    this.line_buffer = "";
    this.initialized_agent_session_id = null;
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
        id: null,
        error: {
          code: -32700,
          message: "invalid JSON",
        },
      });
      return;
    }

    if (typeof request.id === "undefined" || request.id === null) {
      await this.dispatch_notification(request);
      return;
    }

    const response = await this.dispatch_request(request);
    if (response) {
      this.write_response(response);
    }
  }

  private async dispatch_notification(request: json_rpc_request): Promise<void> {
    if (request.method === "notifications/initialized" || request.method === "initialized") {
      return;
    }

    if (request.method === "notifications/cancelled") {
      return;
    }
  }

  private async dispatch_request(request: json_rpc_request): Promise<json_rpc_response | null> {
    try {
      if (request.method === "initialize") {
        const protocol_version = this.resolve_requested_protocol_version(request);
        const client_name = this.resolve_client_name(request);
        const token = typeof request.params?.token === "string" ? request.params.token : undefined;

        if (this.initialized_agent_session_id) {
          try {
            await this.runtime.tool_router.close_session(this.initialized_agent_session_id);
          } catch {
            // Best-effort close for restarted MCP clients.
          }
          this.initialized_agent_session_id = null;
        }

        const result = this.runtime.tool_router.open_session(client_name, token);
        this.initialized_agent_session_id = result.agent_session_id;
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: protocol_version,
            capabilities: {
              tools: {
                listChanged: false,
              },
            },
            serverInfo: server_info,
            protocol_version: local_protocol_version,
            agent_session_id: result.agent_session_id,
          },
        };
      }

      if (request.method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            tools: this.runtime.tool_router.list_tools(),
          },
        };
      }

      if (request.method === "tools/call") {
        const legacy_agent_session_id = request.params?.agent_session_id;
        const tool_name = request.params?.name;
        const args = request.params?.arguments;
        const agent_session_id =
          typeof legacy_agent_session_id === "string" && legacy_agent_session_id.length > 0
            ? legacy_agent_session_id
            : this.initialized_agent_session_id;

        if (!agent_session_id || typeof tool_name !== "string") {
          throw new tool_error("INVALID_ARGUMENT", "tools/call requires agent_session_id and name", false);
        }

        const parsed_args = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const result = await this.runtime.tool_router.call_tool(agent_session_id, tool_name, parsed_args);

        if (typeof legacy_agent_session_id === "string" && legacy_agent_session_id.length > 0) {
          return {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result,
          };
        }

        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: this.to_mcp_tool_result(result),
        };
      }

      if (request.method === "session/close") {
        const agent_session_id = request.params?.agent_session_id;
        const resolved_agent_session_id =
          typeof agent_session_id === "string" && agent_session_id.length > 0
            ? agent_session_id
            : this.initialized_agent_session_id;
        if (!resolved_agent_session_id) {
          throw new tool_error("INVALID_ARGUMENT", "session/close requires agent_session_id", false);
        }

        const result = await this.runtime.tool_router.close_session(resolved_agent_session_id);
        if (this.initialized_agent_session_id === resolved_agent_session_id) {
          this.initialized_agent_session_id = null;
        }

        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result,
        };
      }

      if (request.method === "sessions/list") {
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            sessions: this.runtime.session_registry.list_active_sessions(),
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: -32601,
          message: `unknown method: ${request.method}`,
        },
      };
    } catch (error) {
      if (error instanceof tool_error) {
        if (request.method === "tools/call") {
          return {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: this.to_mcp_tool_error_result(error),
          };
        }

        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
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
        id: request.id ?? null,
        error: {
          code: -32603,
          message,
        },
      };
    }
  }

  private resolve_requested_protocol_version(request: json_rpc_request): string {
    const value = request.params?.protocolVersion;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    return default_mcp_protocol_version;
  }

  private resolve_client_name(request: json_rpc_request): string | undefined {
    const client_info = request.params?.clientInfo;
    if (client_info && typeof client_info === "object") {
      const candidate = (client_info as Record<string, unknown>).name;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    const legacy_client_name = request.params?.client_name;
    if (typeof legacy_client_name === "string" && legacy_client_name.trim().length > 0) {
      return legacy_client_name.trim();
    }

    return undefined;
  }

  private to_mcp_tool_result(result: Record<string, unknown>): Record<string, unknown> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
      structuredContent: result,
    };
  }

  private to_mcp_tool_error_result(error: tool_error): Record<string, unknown> {
    return {
      content: [
        {
          type: "text",
          text: error.message,
        },
      ],
      structuredContent: error.to_payload(),
      isError: true,
    };
  }

  private write_response(response: json_rpc_response): void {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
