import { tool_error } from "./errors";
import { local_mcp_runtime } from "./runtime";
import type { json_rpc_request, json_rpc_response } from "./types";

const default_mcp_protocol_version = "2024-11-05";
const local_protocol_version = "local-mcp-bun-v2";

export const server_info = {
  name: "local-mcp",
  version: "0.2.3",
} as const;

interface mcp_protocol_session_options {
  runtime: local_mcp_runtime;
  write_response: (response: json_rpc_response) => void;
}

export class mcp_protocol_session {
  private readonly runtime: local_mcp_runtime;
  private readonly write_response: (response: json_rpc_response) => void;
  private initialized_agent_session_id: string | null;
  private closed: boolean;

  public constructor(options: mcp_protocol_session_options) {
    this.runtime = options.runtime;
    this.write_response = options.write_response;
    this.initialized_agent_session_id = null;
    this.closed = false;
  }

  public async handle_line(line: string): Promise<void> {
    if (this.closed) {
      return;
    }

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

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (!this.initialized_agent_session_id) {
      return;
    }

    try {
      await this.runtime.tool_router.close_session(this.initialized_agent_session_id);
    } catch {
      // Best-effort cleanup for dropped client sessions.
    } finally {
      this.initialized_agent_session_id = null;
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
          result: this.to_mcp_tool_result(tool_name, result),
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

  private to_mcp_tool_result(tool_name: string, result: Record<string, unknown>): Record<string, unknown> {
    if (tool_name === "browser_take_screenshot") {
      const screenshot_result = this.to_mcp_screenshot_tool_result(result);
      if (screenshot_result) {
        return screenshot_result;
      }
    }

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

  private to_mcp_screenshot_tool_result(result: Record<string, unknown>): Record<string, unknown> | null {
    const raw_data_base64 = typeof result.data_base64 === "string" ? result.data_base64 : this.extract_data_from_data_url(result);
    if (!raw_data_base64) {
      return null;
    }

    const mime_type =
      typeof result.mime_type === "string" && result.mime_type.length > 0 ? result.mime_type : this.extract_mime_type(result);

    const structured_content: Record<string, unknown> = {
      has_image: true,
    };

    for (const key of ["tab_id", "format", "bytes", "capture_mode", "full_page", "selector", "quality", "clip"]) {
      if (typeof result[key] !== "undefined") {
        structured_content[key] = result[key];
      }
    }

    structured_content.mime_type = mime_type;

    return {
      content: [
        {
          type: "image",
          data: raw_data_base64,
          mimeType: mime_type,
        },
        {
          type: "text",
          text: JSON.stringify(structured_content),
        },
      ],
      structuredContent: structured_content,
    };
  }

  private extract_data_from_data_url(result: Record<string, unknown>): string | null {
    const data_url = typeof result.data_url === "string" ? result.data_url : "";
    const match = /^data:([^;]+);base64,(.+)$/u.exec(data_url);
    if (!match) {
      return null;
    }

    return match[2] ?? null;
  }

  private extract_mime_type(result: Record<string, unknown>): string {
    const data_url = typeof result.data_url === "string" ? result.data_url : "";
    const match = /^data:([^;]+);base64,/u.exec(data_url);
    if (!match || typeof match[1] !== "string" || match[1].length === 0) {
      return "image/png";
    }

    return match[1];
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
}
