# Local MCP Bun

Modified by [KnotFalse].

For user-facing install, client setup, and privacy policy, start at:
- `../README.md`
- `../PRIVACY.md`

This project provides a local-only MCP server that multiplexes multiple agent sessions through one shared browser extension connection while enforcing per-tab debugger locks.

## Key Guarantees

- Local loopback binding by default.
- Optional token authentication.
- One lock owner per `tab_id`.
- Required tools: `list_available_tabs`, `attach_to_tab`, `detach_from_tab`.
- Broad forwarded browser tool surface under `browser_*` names (lock-aware tab-scoped routing).
- Built-in LLM onboarding via MCP prompts (`learn_browser_mcp`, `attach_and_observe`, `network_debug_flow`) and fallback `learn_browser_mcp` tool guidance.
- Hard-gate test command: `bun run test:hard-gate`.

## LLM Onboarding

- If your MCP client surfaces prompts, start with:
  - `prompts/get name=learn_browser_mcp`
- If your client does not surface prompts well, call:
  - `tools/call name=learn_browser_mcp`
- Useful ergonomic behaviors:
  - `browser_tabs { action: "new", url }` creates a tab and immediately attaches it for the current session.
  - `browser_navigate` accepts `{ url: "https://example.com" }` and defaults it to `action="url"`.
  - `browser_network_requests` accepts both `requestId` and `request_id`.
  - `detach_from_tab` may omit `tab_id` only when the session owns exactly one tab.

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
- Verify packaged extension zip integrity:
  - `cd local-mcp-bun && bun run verify:release-extension -- --zip dist/release/v<version>/chrome-browser-mcp-chrome-extension-v<version>.zip`
- Verify release version matches `package.json` and `chrome-extension/manifest.json`:
  - `just package-version-check version=v0.4.0`

Artifacts are written to `local-mcp-bun/dist/release/v<version>/` with `SHA256SUMS.txt`.

## Troubleshooting

- Extension logs repeated `ERR_CONNECTION_REFUSED` for `ws://127.0.0.1:37777/extension`:
  - Start the MCP server and verify daemon health: `curl http://127.0.0.1:37778/health`
  - If using the packaged binary, force daemon mode once to confirm bind ownership:
    - `MCP_DAEMON_MODE=daemon ./chrome-browser-mcp-v<version>-linux-x64`
  - Confirm popup MCP port matches server `BRIDGE_PORT`.

- Packaged extension fails with `Service worker registration failed ... fetching background.js`:
  - Use release `v0.4.0` or newer. Packaging now includes transitive module imports required by `background.js`.

- Windows Chrome with WSL server:
  - Keep MCP bridge settings loopback-only and run the server first.
  - Validate server listener from Windows host before loading extension:
    - `Invoke-WebRequest http://127.0.0.1:37778/health`
  - This applies to the MCP bridge itself, not to ad hoc page fixtures you host inside WSL for live browser testing.
  - If Browser MCP reports `Frame with ID 0 is showing error page` on a local WSL fixture, verify that Windows Chrome can actually open that fixture before blaming the MCP.
  - Do not assume a WSL process bound to `127.0.0.1` is reachable from Windows Chrome on every machine.

### Manual Live Smoke for Windows Chrome + WSL

- Keep the Browser MCP server on loopback. Do not widen `BRIDGE_HOST`.
- For manual page-fixture validation from Windows Chrome against a Bun process running inside WSL, use the dedicated cross-host fixture helper:
  - `cd local-mcp-bun && bun run scripts/manual_validation_fixture.ts`
- The helper binds the page fixture to `0.0.0.0`, prints candidate URLs, and leaves the MCP bridge untouched.
- Recommended flow:
  - Start the MCP server normally.
  - Start the manual fixture helper.
  - Open one of the printed URLs in Windows Chrome.
  - Attach Browser MCP to that tab and run live checks.
- If the printed `http://127.0.0.1:PORT/` candidate fails from Windows Chrome, try one of the printed non-loopback candidate URLs instead.

## Test

```bash
bunx playwright install chromium
bun run lint:docs
bun run test:hard-gate
```
