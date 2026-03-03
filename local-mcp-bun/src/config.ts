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
