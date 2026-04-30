// Modified by [KnotFalse]
import { tool_error } from "./errors";
import { local_mcp_runtime } from "./runtime";
import {
  clone_artifact_root_context,
  clone_artifact_root_context_input,
  resolve_default_artifact_root,
  type artifact_root_context,
  type artifact_root_context_input,
} from "./artifacts";
import type { json_rpc_request, json_rpc_response } from "./types";

const default_mcp_protocol_version = "2024-11-05";
const local_protocol_version = "local-mcp-bun-v2";

export const server_info = {
  name: "local-mcp",
  version: "0.6.1",
} as const;

interface mcp_protocol_session_options {
  runtime: local_mcp_runtime;
  write_response: (response: json_rpc_response) => void;
  artifact_root_context?: artifact_root_context_input;
  on_agent_session_bound?: (agent_session_id: string) => void;
  on_agent_session_released?: (agent_session_id: string) => void;
}

export class mcp_protocol_session {
  private readonly runtime: local_mcp_runtime;
  private readonly write_response: (response: json_rpc_response) => void;
  private readonly artifact_root_context_source: artifact_root_context_input;
  private readonly on_agent_session_bound?: (agent_session_id: string) => void;
  private readonly on_agent_session_released?: (agent_session_id: string) => void;
  private pinned_artifact_root_context: artifact_root_context | null;
  private initialized_agent_session_id: string | null;
  private initialized_client_name: string | undefined;
  private initialized_token: string | undefined;
  private initialized_auth_mode: "none" | "token" | null;
  private closed: boolean;

  public constructor(options: mcp_protocol_session_options) {
    this.runtime = options.runtime;
    this.write_response = options.write_response;
    this.artifact_root_context_source = clone_artifact_root_context_input(
      options.artifact_root_context ?? resolve_default_artifact_root(),
    );
    this.on_agent_session_bound = options.on_agent_session_bound;
    this.on_agent_session_released = options.on_agent_session_released;
    this.pinned_artifact_root_context = null;
    this.initialized_agent_session_id = null;
    this.initialized_client_name = undefined;
    this.initialized_token = undefined;
    this.initialized_auth_mode = null;
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
      this.clear_initialized_client_state();
    }
  }

  public has_recoverable_initialized_state(): boolean {
    return !this.closed && this.initialized_auth_mode !== null;
  }

  private async dispatch_notification(request: json_rpc_request): Promise<void> {
    if (request.method === "notifications/initialized" || request.method === "initialized") {
      this.touch_or_rebind_initialized_session_for_notification();
      return;
    }

    if (request.method === "notifications/cancelled") {
      this.touch_or_rebind_initialized_session_for_notification();
      return;
    }
  }

  private async dispatch_request(request: json_rpc_request): Promise<json_rpc_response | null> {
    try {
      if (request.method === "initialize") {
        const protocol_version = this.resolve_requested_protocol_version(request);
        const client_name = this.resolve_client_name(request);
        const token = typeof request.params?.token === "string" ? request.params.token : undefined;

        const previous_agent_session_id = this.initialized_agent_session_id;
        this.clear_initialized_client_state();
        if (previous_agent_session_id) {
          try {
            await this.runtime.tool_router.close_session(previous_agent_session_id);
          } catch {
            // Best-effort close for restarted MCP clients.
          }
        }

        const result = this.runtime.tool_router.open_session(
          client_name,
          token,
          this.resolve_artifact_root_context_for_open(),
        );
        const session = this.runtime.session_registry.get_session(result.agent_session_id);
        this.pin_artifact_root_context(result.agent_session_id);
        this.initialized_client_name = client_name;
        this.initialized_token = session.auth_mode === "token" ? token : undefined;
        this.initialized_auth_mode = session.auth_mode;
        this.set_initialized_agent_session_id(result.agent_session_id);
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: protocol_version,
            capabilities: {
              prompts: {
                listChanged: false,
              },
              tools: {
                listChanged: false,
              },
            },
            serverInfo: server_info,
            protocol_version: local_protocol_version,
            agent_session_id: result.agent_session_id,
            instructions: this.runtime.tool_router.get_initialize_instructions(),
          },
        };
      }

      if (request.method === "prompts/list") {
        this.touch_or_rebind_initialized_session_if_present();
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            prompts: this.runtime.tool_router.list_prompts(),
          },
        };
      }

      if (request.method === "prompts/get") {
        this.touch_or_rebind_initialized_session_if_present();
        const prompt_name = request.params?.name;
        const prompt_arguments =
          request.params?.arguments && typeof request.params.arguments === "object"
            ? (request.params.arguments as Record<string, unknown>)
            : {};
        if (typeof prompt_name !== "string" || prompt_name.length === 0) {
          throw new tool_error("INVALID_ARGUMENT", "prompts/get requires name", false);
        }

        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: this.runtime.tool_router.get_prompt(prompt_name, prompt_arguments),
        };
      }

      if (request.method === "tools/list") {
        this.touch_or_rebind_initialized_session_if_present();
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            tools: this.runtime.tool_router.list_tools(),
          },
        };
      }

      if (request.method === "tools/call") {
        const tool_name = request.params?.name;
        const args = request.params?.arguments;
        const legacy_agent_session_id = request.params?.agent_session_id;
        const agent_session_id = this.resolve_requested_agent_session_id(legacy_agent_session_id);

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
        const resolved_agent_session_id = this.resolve_requested_agent_session_id(request.params?.agent_session_id, {
          allow_implicit_rebind: false,
        });
        if (!resolved_agent_session_id) {
          throw new tool_error("INVALID_ARGUMENT", "session/close requires agent_session_id", false);
        }

        const result = await this.runtime.tool_router.close_session(resolved_agent_session_id);
        if (this.initialized_agent_session_id === resolved_agent_session_id) {
          this.clear_initialized_client_state();
        }

        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result,
        };
      }

      if (request.method === "sessions/list") {
        this.touch_or_rebind_initialized_session_if_present();
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

  private set_initialized_agent_session_id(agent_session_id: string): void {
    this.initialized_agent_session_id = agent_session_id;
    if (!this.on_agent_session_bound) {
      return;
    }

    try {
      this.on_agent_session_bound(agent_session_id);
    } catch (error) {
      console.error("failed to run on_agent_session_bound callback", error);
    }
  }

  private clear_initialized_agent_session_id(): void {
    if (!this.initialized_agent_session_id) {
      return;
    }

    const released_agent_session_id = this.initialized_agent_session_id;
    this.initialized_agent_session_id = null;
    if (!this.on_agent_session_released) {
      return;
    }

    try {
      this.on_agent_session_released(released_agent_session_id);
    } catch (error) {
      console.error("failed to run on_agent_session_released callback", error);
    }
  }

  private clear_initialized_client_state(): void {
    this.clear_initialized_agent_session_id();
    this.initialized_client_name = undefined;
    this.initialized_token = undefined;
    this.initialized_auth_mode = null;
  }

  private touch_or_rebind_initialized_session_if_present(): void {
    const initialized_agent_session_id = this.ensure_initialized_agent_session_id();
    if (!initialized_agent_session_id) {
      return;
    }

    this.touch_session(initialized_agent_session_id);
  }

  private touch_or_rebind_initialized_session_for_notification(): void {
    try {
      this.touch_or_rebind_initialized_session_if_present();
    } catch (error) {
      this.clear_initialized_client_state();
      console.error("failed to refresh MCP notification session", error);
    }
  }

  private touch_session(agent_session_id: string): void {
    this.runtime.session_registry.touch_session(agent_session_id);
  }

  private resolve_artifact_root_context_for_open(): artifact_root_context_input {
    return this.pinned_artifact_root_context ?? this.artifact_root_context_source;
  }

  private pin_artifact_root_context(agent_session_id: string): void {
    if (this.pinned_artifact_root_context) {
      return;
    }

    this.pinned_artifact_root_context = clone_artifact_root_context(
      this.runtime.session_registry.get_session_artifact_root_context(agent_session_id),
    );
  }

  private resolve_initialized_agent_session_id(): string | null {
    if (!this.initialized_agent_session_id) {
      return null;
    }

    if (!this.runtime.session_registry.has_session(this.initialized_agent_session_id)) {
      this.clear_initialized_agent_session_id();
      return null;
    }

    return this.initialized_agent_session_id;
  }

  private ensure_initialized_agent_session_id(): string | null {
    const initialized_agent_session_id = this.resolve_initialized_agent_session_id();
    if (initialized_agent_session_id) {
      return initialized_agent_session_id;
    }

    if (!this.initialized_auth_mode) {
      return null;
    }

    let result: { agent_session_id: string };
    try {
      result = this.runtime.tool_router.open_session(
        this.initialized_client_name,
        this.initialized_token,
        this.resolve_artifact_root_context_for_open(),
      );
    } catch (error) {
      this.clear_initialized_client_state();
      throw error;
    }

    const session = this.runtime.session_registry.get_session(result.agent_session_id);
    this.pin_artifact_root_context(result.agent_session_id);
    this.initialized_auth_mode = session.auth_mode;
    this.set_initialized_agent_session_id(result.agent_session_id);
    return result.agent_session_id;
  }

  private resolve_requested_agent_session_id(
    explicit_agent_session_id: unknown,
    options: { allow_implicit_rebind?: boolean } = {},
  ): string | null {
    if (typeof explicit_agent_session_id !== "string" || explicit_agent_session_id.length === 0) {
      if (options.allow_implicit_rebind === false) {
        return this.resolve_initialized_agent_session_id();
      }

      return this.ensure_initialized_agent_session_id();
    }

    if (this.runtime.session_registry.has_session(explicit_agent_session_id)) {
      return explicit_agent_session_id;
    }

    if (this.initialized_agent_session_id === explicit_agent_session_id) {
      this.clear_initialized_agent_session_id();
    }

    throw new tool_error("SESSION_NOT_FOUND", `unknown session: ${explicit_agent_session_id}`, false, {
      agent_session_id: explicit_agent_session_id,
    });
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
    if (tool_name === "learn_browser_mcp") {
      return this.to_mcp_help_tool_result(result);
    }

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

    for (const key of [
      "tab_id",
      "format",
      "bytes",
      "capture_mode",
      "full_page",
      "selector",
      "element_ref",
      "quality",
      "clip",
      "device_scale",
      "highlight_clickables",
      "highlighted_clickable_count",
      "saved",
      "path",
      "saved_path",
    ]) {
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

  private to_mcp_help_tool_result(result: Record<string, unknown>): Record<string, unknown> {
    const markdown = typeof result.markdown === "string" ? result.markdown : JSON.stringify(result);
    return {
      content: [
        {
          type: "text",
          text: markdown,
        },
      ],
      structuredContent: result,
    };
  }

  private to_mcp_tool_error_result(error: tool_error): Record<string, unknown> {
    const detail_text: string[] = [error.message];
    const recovery_hint = typeof error.details?.recovery_hint === "string" ? error.details.recovery_hint : null;
    if (recovery_hint) {
      detail_text.push(`Hint: ${recovery_hint}`);
    }

    if (typeof error.details?.canonical_example !== "undefined") {
      detail_text.push(`Example: ${JSON.stringify(error.details.canonical_example)}`);
    }

    return {
      content: [
        {
          type: "text",
          text: detail_text.join("\n"),
        },
      ],
      structuredContent: error.to_payload(),
      isError: true,
    };
  }
}
