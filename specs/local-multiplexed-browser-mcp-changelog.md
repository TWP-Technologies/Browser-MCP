# Local Multiplexed Browser MCP Spec Changelog

## 2026-03-16

### Implemented

- Replaced visible-tab screenshot capture with debugger-backed screenshot capture in the co-located Chrome extension.
- Added screenshot mode support for:
  - viewport capture,
  - full-page capture,
  - selector capture with padding,
  - coordinate clip capture.
- Updated MCP protocol response shaping so `browser_take_screenshot` returns an MCP image content block plus structured metadata instead of only JSON text.
- Added explicit screenshot tool schema metadata to the Bun router tool list.
- Extended in-memory integration test stubs to return deterministic screenshot payloads.
- Added integration coverage for attached screenshot payloads and MCP image-content compatibility.
- Added real-browser E2E coverage for viewport/full-page/selector screenshot capture plus missing-selector failure.
- Updated the E2E fixture harness to avoid `Bun.serve({ port: 0 })` in this Linux environment by using explicit loopback port retries.

### Verification

- `bun test ./tests/integration/tool_router.test.ts ./tests/integration/mcp_stdio_protocol_compat.test.ts` passed.
- `bun test ./tests/e2e/extension_screenshot_direct.test.ts --timeout 120000` passed.

## 2026-03-04

### Implemented

- Added shared singleton daemon model for websocket mode:
  - one daemon/runtime owns `BRIDGE_PORT` (default `37777`) and extension bridge,
  - MCP client processes proxy stdio over daemon ingress (`MCP_DAEMON_PORT`, default `BRIDGE_PORT + 1`).
- Added new startup orchestration modes:
  - `MCP_DAEMON_MODE=auto|proxy|daemon|direct`.
- Added daemon ingress server with:
  - loopback-only `/mcp` WebSocket endpoint for proxy sessions,
  - `/health` endpoint exposing runtime/bridge/proxy status.
- Added per-external-client session mapping by binding one protocol session to each ingress WebSocket connection.
- Added proxy server that forwards stdio JSON-RPC lines to daemon ingress and returns daemon responses back to stdout.
- Added daemon idle shutdown support (`MCP_DAEMON_IDLE_TIMEOUT_MS`, default 15 minutes).
- Added daemon state metadata file support (`MCP_DAEMON_STATE_PATH`) and bridge+1 ingress default documentation.
- Added daemon-mode auth behavior:
  - `MCP_AUTH_TOKEN=auto` is generated/reused by daemon runtime and persisted in daemon state metadata,
  - proxy prints full token when auto-auth is requested and also reports redacted auth hints.
- Added integration coverage for two concurrent MCP clients sharing one daemon/runtime with no second bridge bind.
- Added config unit tests for daemon mode/port/timeout resolution.
- Updated README with daemon model behavior, env configuration, and explicit examples.

### Verification

- `bun run test:unit` passed.
- `bun run test:integration` passed.
- `bun run test:fault` passed.
- `bun run lint:spec` passed.
- `bun run lint:compliance` passed.

## 2026-03-03

### Implemented

- Added official `blueprint-mcp` upstream as pinned git submodule at `blueprint-mcp/`.
- Created `local-mcp-bun/` Bun + TypeScript implementation scaffold with runtime, session registry, lock manager, bridge transport, and stdio JSON-RPC handler.
- Implemented required tools in router layer:
  - `list_available_tabs`
  - `attach_to_tab`
  - `detach_from_tab`
- Implemented deterministic lock conflict and wait-timeout behavior.
- Added in-memory bridge transport for repeatable tests.
- Added co-located extension skeleton under `local-mcp-bun/chrome-extension/` with WebSocket bridge protocol and `chrome.debugger` attach/detach handlers.
- Added hard-gate local test scripts and CI workflow matrix for Linux/macOS/Windows.
- Updated `AGENTS.md` with living-spec directives and co-located extension policy.
- Expanded routed browser tool surface in server + extension bridge:
  - Added forwarded `browser_*` passthrough routing with active-tab lock ownership enforcement.
  - Added extension-side `call_tool` dispatcher for tab, navigation, snapshot, screenshot, evaluate, interact, fill form, lookup, verify, extract, style, window, dialog, extension-management, and performance operations.
- Added additional integration tests for lock-aware `browser_tabs` workflows and tab-scoped tool precondition checks.
- Added compliance scanner command (`lint:compliance`) and required-notice/forbidden-token checks.
- Added real-browser E2E harness using Playwright persistent Chromium context with loaded MV3 extension.
- Added debugger-backed implementations for higher-fidelity forwarded tools:
  - `browser_evaluate` via `Runtime.evaluate`
  - `browser_network_requests` list/details/clear with event capture from `chrome.debugger.onEvent`
  - `browser_pdf_save` via `Page.printToPDF`
- Extended hard gate to include `test:e2e` and CI browser installation steps for Playwright.
- Added bridge state-change reconciliation path in router to recover from stale lock ownership after extension reconnect.
- Added fault test for stale-lock cleanup after disconnect/reconnect and integration test for optional token auth enforcement.
- Enforced ASID request envelope metadata for all extension-bound bridge actions (`list_tabs`, `attach_to_tab`, `detach_from_tab`, `call_tool`).
- Added extension response ASID echoing and server-side response/session correlation validation to prevent cross-session response contamination.
- Added in-memory bridge request log + detach-notice test hooks for deterministic envelope and recovery verification.
- Added integration coverage proving session-isolated ASID propagation across concurrent sessions.
- Updated fault coverage to verify automatic reconciliation on reconnect without manual invocation.
- Added detach-notice fault coverage ensuring lock cleanup when browser target closes externally.
- Added websocket bridge test hook for forced extension disconnect to validate in-flight failure handling and reconnect recovery.
- Added fault test using a fake websocket extension to prove in-flight request rejection on disconnect and successful post-reconnect recovery.
- Added E2E regression test proving mid-command websocket disconnect returns deterministic error and subsequent calls recover after reconnect.
- Upgraded compliance scanner to explicit rule IDs (`CR-001`..`CR-006`) mapped to `FR-018`.
- Added scanner CLI options (`--root`, `--format`) for fixture-driven validation.
- Added unit tests with pass/fail fixtures for forbidden endpoint token and required-notice enforcement.
- Updated CI workflow to:
  - run `lint:compliance` explicitly,
  - emit per-OS hard-gate evidence JSON,
  - upload matrix evidence artifacts for Linux/macOS/Windows.
- Added runtime shutdown cleanup to reclaim tab locks and close active sessions even when clients do not call `session/close` (FR-008 crash/disconnect path).
- Added loopback-only bridge host enforcement and reject-non-loopback guardrails (FR-011).
- Added optional auto-generated auth token mode (`MCP_AUTH_TOKEN=auto` or `MCP_AUTH_AUTO=1`) to avoid manual token pre-provisioning while keeping auth optional.
- Added security and crash-recovery tests:
  - unit config tests for loopback and auth-token resolution,
  - integration guard test for non-loopback host rejection,
  - fault test for lock reclamation on runtime shutdown without explicit session close.
- Updated living spec statuses to close `FR-008`, `FR-009`, `FR-011`, `FR-014`, and `FR-018`.

### Verification

- `bun test` in `local-mcp-bun/` passed (`12 pass`, `0 fail`).
- `bun run lint:spec` passed.
- `bun run lint:compliance` passed.
- `bun run test:hard-gate` passed (`32 pass`, `0 fail`, including real extension E2E reconnect regression, websocket disconnect fault recovery, FR-008 shutdown reclamation, FR-011 loopback/auth tests, and compliance scanner unit coverage).

### Remaining High-Priority Work

- None for current v1 scope tracked by `FR-001`..`FR-018`.
