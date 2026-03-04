import {
  resolve_bridge_mode,
  resolve_daemon_connect_timeout_ms,
  resolve_daemon_idle_timeout_ms,
  resolve_daemon_mode,
  resolve_daemon_port,
} from "./config";
import { resolve_daemon_state_path, run_daemon_mode } from "./daemon_controller";

function get_env_string(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return value;
}

function parse_port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const bridge_mode = resolve_bridge_mode(env);
  const bridge_host = get_env_string("BRIDGE_HOST") ?? "127.0.0.1";
  const bridge_port = parse_port("BRIDGE_PORT", 37777);
  const daemon_mode = resolve_daemon_mode(env, bridge_mode);
  const daemon_host = get_env_string("MCP_DAEMON_HOST") ?? "127.0.0.1";
  const daemon_port = resolve_daemon_port(env, bridge_port);
  const daemon_idle_timeout_ms = resolve_daemon_idle_timeout_ms(env);
  const daemon_connect_timeout_ms = resolve_daemon_connect_timeout_ms(env);
  const daemon_state_path = resolve_daemon_state_path(env, daemon_port);

  await run_daemon_mode({
    daemon_mode,
    daemon_host,
    daemon_port,
    daemon_idle_timeout_ms,
    daemon_connect_timeout_ms,
    daemon_state_path,
    runtime_options: {
      bridge_mode,
      bridge_host,
      bridge_port,
    },
    env,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
