# Local MCP Bun

Modified by [KnotFalse].

This project provides a local-only MCP server that multiplexes multiple agent sessions through one shared browser extension connection while enforcing per-tab debugger locks.

## Key Guarantees

- Local loopback binding by default.
- Optional token authentication.
- One lock owner per `tab_id`.
- Required tools: `list_available_tabs`, `attach_to_tab`, `detach_from_tab`.
- Broad forwarded browser tool surface under `browser_*` names (lock-aware tab-scoped routing).
- Hard-gate test command: `bun run test:hard-gate`.

## Run

```bash
bun run src/index.ts
```

Default runtime is:
- `BRIDGE_MODE=websocket`
- `BRIDGE_HOST=127.0.0.1`
- `BRIDGE_PORT=37777`
- `MCP_DAEMON_MODE=auto` (for websocket mode)
- `MCP_DAEMON_PORT=BRIDGE_PORT+1` (default `37778`)

With defaults, each MCP client process is a stdio proxy that auto-connects to a shared local daemon. The daemon owns the browser bridge bind (`BRIDGE_PORT`) and supports multiple concurrent MCP clients.

### Daemon Modes

- `MCP_DAEMON_MODE=auto` (default for `BRIDGE_MODE=websocket`): connect to existing daemon or spawn one, then proxy stdio to daemon ingress.
- `MCP_DAEMON_MODE=proxy`: connect to existing daemon only; fail if unavailable.
- `MCP_DAEMON_MODE=daemon`: run the shared daemon/runtime directly.
- `MCP_DAEMON_MODE=direct`: legacy one-process runtime (no shared daemon/proxy).

If `BRIDGE_MODE=in_memory`, runtime always uses direct mode for deterministic local tests.

### Example Commands

- Default shared-daemon workflow:
  - `bun run src/index.ts`
- Explicit daemon:
  - `MCP_DAEMON_MODE=daemon bun run src/index.ts`
- Legacy direct workflow:
  - `MCP_DAEMON_MODE=direct bun run src/index.ts`
- In-memory test mode:
  - `BRIDGE_MODE=in_memory bun run src/index.ts`

You only need to set bridge env vars when overriding defaults (for example custom port, host, or `BRIDGE_MODE=in_memory` test mode).

## Security Configuration

- `BRIDGE_MODE` defaults to `websocket` and accepts only `websocket` or `in_memory`.
- `BRIDGE_HOST` MUST be loopback-only (`127.x.x.x`, `localhost`, `::1`).
- `MCP_DAEMON_HOST` defaults to `127.0.0.1`.
- `MCP_DAEMON_PORT` defaults to `BRIDGE_PORT+1`.
- `MCP_DAEMON_IDLE_TIMEOUT_MS` defaults to `900000` (15 minutes).
- `MCP_DAEMON_CONNECT_TIMEOUT_MS` defaults to `10000`.
- `MCP_DAEMON_STATE_PATH` overrides daemon metadata path (default temp path keyed by daemon port).
- `MCP_AUTH_TOKEN=<value>` enables token auth with explicit value.
- `MCP_AUTH_TOKEN=auto` or `MCP_AUTH_AUTO=1` enables token auth with auto token generated/reused by the daemon runtime and persisted in daemon state metadata.
- If auth env vars are not set, auth remains disabled (local loopback boundary still enforced).

### MCP Auth Token: Is It Required?

- By default, token auth is **not required**. Sessions can initialize without a token when `MCP_AUTH_TOKEN`/`MCP_AUTH_AUTO` are unset.
- If you set `MCP_AUTH_TOKEN=<value>`, clients **must** pass the same value in `initialize.params.token`.
- If you set `MCP_AUTH_TOKEN=auto` (or `MCP_AUTH_AUTO=1`) in daemon mode, the daemon reuses or generates a local token and the proxy prints it for client initialization:
  - `[auth] daemon token for initialize.params.token: auto-...`
  - Clients pass that token in `initialize.params.token`.

## Packaging

- Build both artifacts (server binary + extension zip):
  - `just package`
- Build only server binary:
  - `just package-server`
- Build only extension zip:
  - `just package-extension`
- Verify release version matches `package.json` and `chrome-extension/manifest.json`:
  - `just package-version-check version=v0.2.0`

Artifacts are written to `local-mcp-bun/dist/release/v<version>/` with `SHA256SUMS.txt`.

## Test

```bash
bunx playwright install chromium
bun run test:hard-gate
```
