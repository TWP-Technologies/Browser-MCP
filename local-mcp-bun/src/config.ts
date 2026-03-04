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
