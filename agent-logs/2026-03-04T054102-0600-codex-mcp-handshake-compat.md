# Session Log: Codex MCP Handshake Compatibility Fix

- Date: 2026-03-04 (America/Chicago)
- Repository state reference: browser_mcp: trunk @ c8a3492

## Scope
- Fixed MCP stdio handshake incompatibility with Codex CLI.
- Added regression integration test for MCP initialize/call flow.

## Problem
Codex startup failed for `local-browser-use` with:
- `expect initialized result, but received ... {"protocol_version":"local-mcp-bun-v2","agent_session_id":"..."}`

This indicated the server returned a non-standard initialize shape.

## Changes Made
- Updated `local-mcp-bun/src/mcp_stdio_server.ts`:
  - `initialize` now returns MCP-compatible fields:
    - `protocolVersion`
    - `capabilities`
    - `serverInfo`
  - Kept legacy fields in initialize result for compatibility:
    - `protocol_version`
    - `agent_session_id`
  - Added per-connection initialized session tracking for stdio transport.
  - `tools/call` now supports MCP clients without explicit `agent_session_id` after initialize.
  - `tools/call` now returns MCP-style tool result envelope for non-legacy callers.
  - Notification-safe handling for `notifications/initialized` and `notifications/cancelled` (no response emitted).
- Updated `local-mcp-bun/src/types.ts`:
  - JSON-RPC request `id` is optional/null for notifications.
  - JSON-RPC response `id` supports null.
- Added integration test:
  - `local-mcp-bun/tests/integration/mcp_stdio_protocol_compat.test.ts`

## Validation Run
- `bun test tests/integration/mcp_stdio_protocol_compat.test.ts`
- `bun test tests/integration/tool_router.test.ts`
- `bun run check:popup-ui`
- Built patched local binary and validated Codex startup:
  - `codex --ask-for-approval never --sandbox read-only exec "Reply with the single word OK."`
  - Observed `mcp: local-browser-use ready` and successful run.

## Notes
- Existing downloaded `v0.1.0` release binary does not include this fix.
- A new build/release is required for portable distribution of this compatibility fix.

## Recent Commit Context (git log --oneline -10)
- c8a3492 docs(agent-logs): record release asset prefix update
- e6ddb08 chore(release): rename packaged asset prefix to local-mcp
- 7b55db5 docs(agent-logs): record release run and publish fix
- ddc6a52 fix(ci): avoid duplicate checksum asset upload in release job
- 6468fd4 fix(extension): remove idle bridge url helper text from popup
- c962806 docs(agent-logs): update landed commit references
- b274a17 docs(agent-logs): record release packaging and popup copy session
- 353c4db docs(readme): document packaging flow and auth token behavior
- 003c473 feat(extension): add copyable bridge url controls in popup
- 728d885 ci(release): add tagged multi-os release pipeline
