export function now_iso_string(): string {
  return new Date().toISOString();
}

export function generate_agent_session_id(client_name?: string): string {
  const safe_prefix = (client_name ?? "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);

  const suffix = crypto.randomUUID().slice(0, 8);
  const prefix = safe_prefix.length > 0 ? safe_prefix : "agent";
  return `${prefix}-${suffix}`;
}

export function generate_correlation_id(): string {
  return crypto.randomUUID();
}
