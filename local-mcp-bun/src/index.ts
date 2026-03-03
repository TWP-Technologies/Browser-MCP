import { mcp_stdio_server } from "./mcp_stdio_server";
import { resolve_auth_token } from "./config";
import { local_mcp_runtime } from "./runtime";

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
  const bridge_mode = process.env.BRIDGE_MODE === "websocket" ? "websocket" : "in_memory";
  const bridge_host = get_env_string("BRIDGE_HOST") ?? "127.0.0.1";
  const bridge_port = parse_port("BRIDGE_PORT", 37777);
  const auth = resolve_auth_token(process.env as Record<string, string | undefined>);

  const runtime = new local_mcp_runtime({
    bridge_mode,
    bridge_host,
    bridge_port,
    auth_token: auth.auth_token,
  });

  if (auth.generated_automatically) {
    console.error(`[auth] generated one-time MCP token for this server run: ${auth.auth_token}`);
  }

  const server = new mcp_stdio_server(runtime);
  server.start();

  process.on("SIGINT", () => {
    runtime.stop().finally(() => {
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    runtime.stop().finally(() => {
      process.exit(0);
    });
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
