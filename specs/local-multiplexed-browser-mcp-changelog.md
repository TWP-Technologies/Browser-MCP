# Local Multiplexed Browser MCP Spec Changelog

## 2026-04-14

### Implemented

- Reworked advertised Bun-router tool schemas so all MCP `inputSchema` objects avoid top-level `oneOf`, `anyOf`, `allOf`, `enum`, and `not` for OpenAI tool-registration compatibility.
- Preserved alternate argument support for `browser_navigate`, `browser_interact`, and `browser_evaluate` through property-level guidance plus existing runtime validation.
- Added integration coverage that scans every advertised tool schema for forbidden top-level schema keys.
- Removed the remaining property-level composition keyword from `browser_get_element_styles.pseudoState` after review feedback, and tightened regression coverage to reject composition keywords anywhere in advertised tool schemas.
- Restored machine-readable style pseudo-state inputs with `pseudoState` as a string and `pseudoStates` as a string array, while preserving legacy runtime support for `pseudoState` arrays.

### Verification

- `bun test tests/integration/tool_router.test.ts` passed.
- `bun test tests/integration/parity_remaining.test.ts` passed.
- `bun run test:unit` passed.
- `bun run test:integration` passed.
- `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run test:e2e` passed.
- `bun run test:fault` passed.
- `bun run test:concurrency` passed.
- `bun run lint:spec` passed.

## 2026-03-18

### Implemented

- Added MCP prompt support for local onboarding guidance:
  - `learn_browser_mcp`
  - `attach_and_observe`
  - `network_debug_flow`
- Added fallback `learn_browser_mcp` tool output for MCP clients that do not surface prompts well.
- Improved `tools/list` discoverability for high-friction browser tools with clearer descriptions and property-level argument guidance.
- Added narrow LLM-ergonomic contract improvements:
  - `browser_navigate` now defaults to `action='url'` when `url` is provided without `action`
  - `browser_network_requests` accepts `request_id` as an alias for `requestId`
  - `detach_from_tab` infers `tab_id` only when the current session owns exactly one tab
- Added richer corrective error details and initialize-time instructions so MCP clients can recover from common browser-tool mistakes without external docs.
- Extended integration and browser E2E coverage for prompt discovery, ergonomic aliases/defaults, and single-tab detach inference.
- Centralized onboarding prompt metadata and rendering in the Bun router so `prompts/list`, `prompts/get`, and `learn_browser_mcp` all read from one prompt catalog.
- Updated local release identifiers from `0.3.0` to `0.4.0`.

## 2026-03-17

### Implemented

- Closed the remaining local Blueprint browser-tool parity gaps while preserving LLM-optimized contracts:
  - semantic `browser_snapshot` output with viewport metadata and chainable `element_ref`s,
  - richer `browser_lookup` match metadata and CSS rule/cascade reporting in `browser_get_element_styles`,
  - markdown-oriented `browser_extract_content`,
  - explicit `browser_evaluate`, console, network, PDF, extension-management, and performance tool schemas in the Bun router.
- Added remaining media/admin capabilities:
  - screenshot `path`, `highlightClickables`, and `deviceScale`,
  - PDF `path` persistence,
  - network replay plus on-demand response-body inspection and JSONPath-style lookup,
  - richer console filters, extension list/reload reporting, and structured performance metrics.
- Added Bun-router artifact persistence for screenshots and PDFs so `path` writes occur locally in the MCP runtime rather than the extension.
- Tightened Bun-router artifact persistence so screenshot/PDF `path` writes are normalized to workspace-local destinations, reject lexical escapes, and reject symlink-targeted writes outside the workspace boundary.
- Tightened the advertised `browser_evaluate` router schema so callers must provide `expression` or `function` instead of relying on runtime-only validation.
- Converted the browser roundtrip E2E fixture from a `data:` page to a loopback HTTP fixture so extension attach, executeScript, and network-capture paths are verified against a host-accessible page.
- Tightened `element_ref` replay so ambiguous follow-up resolution fails closed with `STALE_ELEMENT_REFERENCE` instead of replaying against a first-match selector.
- Changed `browser_network_requests` to capture metadata eagerly but fetch response bodies lazily on `action=details`, with bounded in-memory caching for retained text-like bodies.
- Unified visual-visibility checks across wait, verify, overlay, snapshot, and lookup paths in the extension runtime.
- Replaced fixed fixture-port probe ranges in the E2E suites with a shared loopback-port allocator that avoids bridge-port collisions.
- Updated the Blueprint parity audit and living spec to mark overlapping tools as behaviorally at parity for local scope.

### Verification

- `bun test ./tests/integration/tool_router.test.ts ./tests/integration/parity_remaining.test.ts ./tests/integration/mcp_stdio_protocol_compat.test.ts` passed.
- `LOCAL_MCP_TEST_BRIDGE_PORT=37879 bun test ./tests/e2e/extension_roundtrip.test.ts --timeout 120000` passed.

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

## 2026-03-17 Follow-up contract hardening

- Fixed `browser_network_requests action=details` so the nested `request` payload stays metadata-only and no longer leaks cached body fields (`response_body`, `response_body_base64`, `response_body_cached_at`).
- Tightened `browser_snapshot` and `browser_lookup` so `element_ref` is emitted only when the runtime already has a replayably stable unique selector; ambiguous nodes now omit `element_ref` instead of handing back an immediately-stale handle.
- Added integration and roundtrip E2E coverage for both behaviors.

## 2026-03-19 Manual validation helper update

- Added a dedicated cross-host manual validation fixture helper for Windows Chrome + WSL live-smoke workflows.
- Updated README guidance to distinguish the loopback-only MCP bridge from the intentionally cross-host page fixture.
- Utility-only change: no MCP protocol, runtime lock, or bridge security-boundary behavior changed.
