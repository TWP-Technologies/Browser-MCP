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

## Security Configuration

- `BRIDGE_HOST` MUST be loopback-only (`127.x.x.x`, `localhost`, `::1`).
- `MCP_AUTH_TOKEN=<value>` enables token auth with explicit value.
- `MCP_AUTH_TOKEN=auto` or `MCP_AUTH_AUTO=1` enables token auth with auto-generated one-time token (printed at startup).
- If auth env vars are not set, auth remains disabled (local loopback boundary still enforced).

### MCP Auth Token: Is It Required?

- By default, token auth is **not required**. Sessions can initialize without a token when `MCP_AUTH_TOKEN`/`MCP_AUTH_AUTO` are unset.
- If you set `MCP_AUTH_TOKEN=<value>`, clients **must** pass the same value in `initialize.params.token`.
- If you set `MCP_AUTH_TOKEN=auto` (or `MCP_AUTH_AUTO=1`), the server prints a generated one-time token on startup:
  - `[auth] generated one-time MCP token for this server run: auto-...`
  - Use that exact token in `initialize.params.token`.

## Packaging

- Build both artifacts (server binary + extension zip):
  - `just package`
- Build only server binary:
  - `just package-server`
- Build only extension zip:
  - `just package-extension`
- Verify release version matches `package.json` and `chrome-extension/manifest.json`:
  - `just package-version-check version=v0.1.0`

Artifacts are written to `local-mcp-bun/dist/release/v<version>/` with `SHA256SUMS.txt`.

## Test

```bash
bunx playwright install chromium
bun run test:hard-gate
```
