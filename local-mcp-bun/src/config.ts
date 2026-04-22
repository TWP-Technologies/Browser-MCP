function get_non_empty_string(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

export type bridge_mode = "in_memory" | "websocket";
export type daemon_mode = "auto" | "proxy" | "daemon" | "direct";

export function is_loopback_host(host: string): boolean {
  const normalized = host.trim().toLowerCase();

  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }

  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export function assert_loopback_host(host: string): string {
  const normalized = host.trim();
  if (!is_loopback_host(normalized)) {
    throw new Error(`bridge_host must be loopback-only, received '${host}'`);
  }

  return normalized;
}

export function resolve_auth_token(env: Record<string, string | undefined>): {
  auth_token?: string;
  generated_automatically: boolean;
} {
  const configured = get_non_empty_string(env.MCP_AUTH_TOKEN);
  if (configured && configured !== "auto") {
    return {
      auth_token: configured,
      generated_automatically: false,
    };
  }

  const auto_requested = configured === "auto" || get_non_empty_string(env.MCP_AUTH_AUTO) === "1";
  if (!auto_requested) {
    return {
      auth_token: undefined,
      generated_automatically: false,
    };
  }

  return {
    auth_token: `auto-${crypto.randomUUID()}`,
    generated_automatically: true,
  };
}

export function resolve_bridge_mode(env: Record<string, string | undefined>): bridge_mode {
  const configured = get_non_empty_string(env.BRIDGE_MODE);
  if (!configured) {
    return "websocket";
  }

  const normalized = configured.toLowerCase();
  if (normalized === "websocket" || normalized === "in_memory") {
    return normalized;
  }

  throw new Error(`BRIDGE_MODE must be either 'websocket' or 'in_memory', received '${configured}'`);
}

function parse_positive_integer(input: string | undefined, fallback: number): number {
  const configured = get_non_empty_string(input);
  if (!configured) {
    return fallback;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parse_non_negative_integer(input: string | undefined, fallback: number): number {
  const configured = get_non_empty_string(input);
  if (!configured) {
    return fallback;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

export function resolve_daemon_mode(
  env: Record<string, string | undefined>,
  resolved_bridge_mode: bridge_mode,
): daemon_mode {
  if (resolved_bridge_mode === "in_memory") {
    return "direct";
  }

  const configured = get_non_empty_string(env.MCP_DAEMON_MODE);
  if (!configured) {
    return "auto";
  }

  const normalized = configured.toLowerCase();
  if (normalized === "auto" || normalized === "proxy" || normalized === "daemon" || normalized === "direct") {
    return normalized;
  }

  throw new Error(`MCP_DAEMON_MODE must be one of 'auto', 'proxy', 'daemon', or 'direct', received '${configured}'`);
}

export function resolve_daemon_port(env: Record<string, string | undefined>, bridge_port: number): number {
  const fallback = bridge_port + 1;
  const parsed = parse_positive_integer(env.MCP_DAEMON_PORT, fallback);
  if (parsed > 65535) {
    return fallback;
  }

  return parsed;
}

export function resolve_daemon_idle_timeout_ms(env: Record<string, string | undefined>): number {
  return parse_positive_integer(env.MCP_DAEMON_IDLE_TIMEOUT_MS, 900_000);
}

export function resolve_daemon_connect_timeout_ms(env: Record<string, string | undefined>): number {
  return parse_positive_integer(env.MCP_DAEMON_CONNECT_TIMEOUT_MS, 10_000);
}

export function resolve_session_idle_timeout_minutes(env: Record<string, string | undefined>): number {
  return parse_non_negative_integer(env.MCP_SESSION_IDLE_TIMEOUT_MINUTES, 120);
}
