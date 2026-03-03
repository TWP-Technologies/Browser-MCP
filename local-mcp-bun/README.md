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

## Test

```bash
bunx playwright install chromium
bun run test:hard-gate
```
