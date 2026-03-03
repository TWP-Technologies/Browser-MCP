export type session_state = "connected" | "disconnecting" | "disconnected";

export type bridge_state = "down" | "connecting" | "up" | "reconnecting";

export type lock_state = "pending_attach" | "attached" | "releasing";

export type error_code =
  | "LOCK_CONFLICT"
  | "LOCK_NOT_OWNED"
  | "TAB_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "EXTENSION_UNAVAILABLE"
  | "ATTACH_FAILED"
  | "DETACH_FAILED"
  | "SESSION_NOT_FOUND"
  | "UNAUTHORIZED"
  | "TIMEOUT";

export interface tool_error_payload {
  code: error_code;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  correlation_id: string;
}

export interface tab_snapshot {
  tab_id: number;
  url: string;
  title: string;
  debugger_attached: boolean;
}

export interface listed_tab_snapshot extends tab_snapshot {
  is_locked_by_agent: boolean;
  locked_by_agent_session_id?: string;
}

export interface agent_session {
  agent_session_id: string;
  client_name?: string;
  connected_at: string;
  last_seen_at: string;
  state: session_state;
  auth_mode: "none" | "token";
  owned_tab_ids: Set<number>;
}

export interface tab_lock {
  tab_id: number;
  owner_agent_session_id: string;
  lock_state: lock_state;
  lock_acquired_at: string;
}

export interface attach_to_tab_input {
  tab_id: number;
  wait_timeout_ms?: number;
}

export interface detach_from_tab_input {
  tab_id: number;
}

export interface extension_response {
  request_id: string;
  agent_session_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface extension_request {
  type: "request";
  request_id: string;
  agent_session_id: string;
  received_at: string;
  action: "list_tabs" | "attach_to_tab" | "detach_from_tab" | "call_tool";
  payload: Record<string, unknown>;
}

export interface extension_register {
  type: "register";
  extension_id: string;
}

export interface extension_tabs_update {
  type: "tabs_update";
  tabs: tab_snapshot[];
}

export interface extension_detach_notice {
  type: "detach_notice";
  tab_id: number;
  reason: string;
}

export type extension_inbound =
  | extension_response
  | extension_register
  | extension_tabs_update
  | extension_detach_notice;

export interface json_rpc_request {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface json_rpc_response {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
