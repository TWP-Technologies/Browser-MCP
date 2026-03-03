import { in_memory_bridge_transport, websocket_bridge_transport, type bridge_transport } from "./bridge_transport";
import { assert_loopback_host } from "./config";
import { session_registry } from "./session_registry";
import { tab_lock_manager } from "./tab_lock_manager";
import { tool_router } from "./tool_router";

export interface runtime_options {
  bridge_mode: "in_memory" | "websocket";
  bridge_host: string;
  bridge_port: number;
  auth_token?: string;
}

export class local_mcp_runtime {
  public readonly session_registry: session_registry;
  public readonly tab_lock_manager: tab_lock_manager;
  public readonly bridge_transport: bridge_transport;
  public readonly tool_router: tool_router;
  private stopped: boolean;

  public constructor(options: runtime_options) {
    const bridge_host = assert_loopback_host(options.bridge_host);
    this.session_registry = new session_registry();
    this.tab_lock_manager = new tab_lock_manager();
    this.bridge_transport = this.create_bridge_transport({
      ...options,
      bridge_host,
    });
    this.tool_router = new tool_router(this.session_registry, this.tab_lock_manager, this.bridge_transport, {
      auth_token: options.auth_token,
    });
    this.stopped = false;

    if (this.bridge_transport instanceof in_memory_bridge_transport) {
      this.bridge_transport.set_tabs_for_tests([
        {
          tab_id: 101,
          url: "https://example.com",
          title: "Example",
          debugger_attached: false,
        },
        {
          tab_id: 102,
          url: "https://developer.chrome.com",
          title: "Chrome Docs",
          debugger_attached: false,
        },
      ]);
    }
  }

  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    const active_sessions = this.session_registry.list_active_sessions();
    for (const agent_session_id of active_sessions) {
      try {
        await this.tool_router.release_locks_for_session(agent_session_id);
      } catch {
        // best-effort shutdown release
      }

      try {
        this.session_registry.close_session(agent_session_id);
      } catch {
        // session may already be closed by another path
      }
    }

    await this.bridge_transport.stop();
  }

  private create_bridge_transport(options: runtime_options): bridge_transport {
    if (options.bridge_mode === "in_memory") {
      return new in_memory_bridge_transport();
    }

    return new websocket_bridge_transport(options.bridge_host, options.bridge_port);
  }
}
