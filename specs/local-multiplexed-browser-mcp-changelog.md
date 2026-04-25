# Local Multiplexed Browser MCP Spec Changelog

## 2026-04-25

### Per-Client Artifact Roots Review Follow-Up

- KnotFalse updated `local-mcp-bun/README.md` together with the per-client artifact-root implementation notes so setup guidance matches the daemon token, attachment, and redaction behavior; compatibility remains backward-compatible for default loopback clients, with explicit opt-out/opt-in controls documented for tunneled or remote daemon deployments.

## 2026-04-24

### Per-Client Artifact Roots

- Shared-daemon stdio proxies now pass their launch cwd to daemon ingress as connection metadata.
- MCP sessions now store an internal artifact root, so screenshot/PDF relative `path` writes are scoped to the calling client session instead of the shared daemon cwd.
- Artifact path validation still rejects workspace escapes and symlink file targets.
- Artifact-root metadata is attached automatically only for loopback daemon URLs; non-loopback attachment requires `MCP_ATTACH_CLIENT_ARTIFACT_ROOT=1`/`true`, and unauthenticated non-loopback daemon ingress rejects it.
- Loopback artifact-root attachment can be disabled with `MCP_ATTACH_CLIENT_ARTIFACT_ROOT=0`/`false` for tunnel or remote-proxy deployments.
- Missing artifact roots now return a descriptive validation error instead of leaking raw `realpath`/`ENOENT` text.
- Parent-directory creation now validates existing path segments before creating missing directories so symlinked ancestors cannot create directories outside the artifact root before rejection.
- Parent-directory creation tolerates concurrent directory creation by treating `EEXIST` as a race to revalidate, not as a persistence failure.
- Artifact writes now revalidate that the session root path still resolves to its original canonical root before root-level files are persisted, preventing post-session root replacement from redirecting artifacts.
- Daemon ingress now requires a daemon-issued artifact-root token before accepting `client_artifact_root` connection metadata, and stdio proxies read that capability from owner-scoped daemon state.
- Proxy connection errors redact artifact-root metadata, and proxies fall back to daemon-cwd artifact writes only when per-client attachment is disabled or not expected.
- Proxies now use daemon-state artifact-root tokens only when the state record matches daemon health by start time, pid, and ports, avoiding stale-token startup failures.
- Default daemon artifact roots now fall back to the OS temp directory if the daemon launch cwd has been deleted, so non-artifact MCP clients can still connect.
- Stdio proxies now skip client artifact-root attachment when their own cwd is unavailable, preventing stale client cwd paths from blocking MCP traffic.
- Artifact root revalidation now reports a normal artifact validation error if the root is deleted before a screenshot/PDF write.
- Proxy artifact-root tokens are now stripped whenever client artifact-root attachment is disabled, and daemon-state token reuse requires the dialed daemon host to match.
- Session artifact roots now live in registry-private storage and are excluded from the exported `agent_session` shape and connection snapshots.
- Proxies now fail startup instead of silently falling back to daemon-cwd artifacts when per-client attachment was expected but the daemon artifact-root token is missing or stale.
- Artifact containment and destination checks now normalize more filesystem race cases, including dot-prefixed child paths and disappearing destination checks.
- Daemon state writes now use a mode-0600 temporary file and atomic rename to avoid exposing refreshed artifact-root tokens through pre-existing broader file modes.
- Daemon state writes no longer chmod after rename, avoiding spurious startup/shutdown failures after a successful atomic state write.
- Daemon-state host matching now treats loopback aliases as equivalent while still rejecting non-loopback mismatches, and artifact-root token validation uses timing-safe comparison.
- Deferred artifact-root resolution failures now report `INVALID_ARGUMENT`, and artifact file writes use a no-follow file open on POSIX to avoid following destination symlinks after validation.
- Artifact persistence now rejects directory targets explicitly, session registry stores artifact-root contexts by copy, and proxy auto-auth token hints are emitted only when daemon state matches the dialed daemon.
- Artifact parent creation now revalidates the walked parent immediately before each nested directory creation, and stdio proxy startup preserves explicit artifact-root URL metadata when cwd is unavailable.
- Artifact writes now open without truncating first and revalidate path parents again before file mutation, reducing parent-symlink races around final file opens.
- Artifact writes now use a same-directory temp file plus final rename, so writable handles are never opened through the caller-requested final pathname.
- Screenshot/PDF calls now keep the captured payload if a post-capture artifact-root lookup races session cleanup, returning `saved: false` with a structured artifact persistence error.
- Stale daemon-state token failures now include the state file path and explicit recovery options.
- Nested artifact directory creation now allows a symlinked artifact root that was already accepted and pinned by realpath, while still rejecting symlinks below that root.
- Proxies now wait for matching daemon state when auto-auth is requested by an auth-enabled daemon, even when artifact-root attachment is disabled, so the generated initialize token can be surfaced.
- Stdio proxy URL building now overwrites stale `client_artifact_root_token` query values with the current daemon-issued token whenever artifact-root attachment is enabled.
- Artifact writes now anchor temp-file creation and final rename to the opened parent directory on Linux, then verify the final realpath matches the requested destination before reporting success.
- MCP protocol sessions now pin the first resolved artifact root context across implicit rebinds, and screenshot/PDF calls preserve `saved: false` artifact responses if cleanup removes the session before the recovery mark.
- Daemon state and ingress health now share one start timestamp, keeping daemon-state freshness checks stable across process startup timing differences.
- Daemon state is now persisted only after ingress binds successfully, and object-form protocol artifact roots are copied before session reuse.
- Proxies now wait for a matching persisted daemon state record before deriving artifact-root tokens, closing the `/health`-before-state first-start race without delaying startup solely for optional auto-auth logging.
- Proxy health polling and daemon-state polling now share one connect deadline so failed startup cannot exceed the advertised daemon connect timeout.
- Daemon idle and signal shutdown now continue ingress/runtime teardown even if the best-effort daemon-state refresh fails.
- Artifact-root context cloning now lives in the shared artifact helper and is reused by protocol sessions and the session registry.
- Raw filesystem failures while persisting artifacts now surface as `TOOL_FAILED` while validation failures remain `INVALID_ARGUMENT`.
- Auth-enabled non-loopback daemon ingress now defers artifact-root filesystem validation until after initialize token validation to avoid pre-auth path-existence probing.

### Verification

- Added unit and integration coverage for encoded proxy artifact-root URLs, daemon-issued artifact-root token attachment and rejection, delayed daemon-state availability after health readiness, remote URL suppression/explicit attach, daemon-ingress artifact root handoff, non-loopback unauthenticated rejection, missing-root errors, pre-auth validation deferral, parent-symlink rejection, root-symlink replacement rejection, and two sessions writing the same relative screenshot path to distinct client roots.

## 2026-04-23

### v0.5.1 Cleanup Contract (FR-016, FR-017)

- FR-016 now treats `MCP_SESSION_IDLE_TIMEOUT_MINUTES=0` as disabled and otherwise soft-reaps idle session browser resources instead of closing live MCP transports.
- FR-016 now closes unrevived resource-reaped registry entries only after one additional timeout window.
- FR-017 now keeps shared-daemon ingress sockets open when they were freshly unbound from a missing session, while still allowing stale unbound sockets to be closed by the same timeout policy.
- The session registry exposes the lifecycle through `mark_resources_reaped`, `mark_session_recovered`, `list_stale_session_ids`, `is_session_stale`, `list_expired_reaped_session_ids`, and `is_reaped_session_expired`; list APIs return sorted IDs for the supplied `timeout_minutes` and optional `now_ms`.

### Implemented

- Changed stale-session cleanup from transport-closing hard reap to browser-resource soft reap for live MCP transports.
- Stale cleanup now releases tab locks, detaches owned tabs, cancels queued waiters, and records `resource_reaped_at` without closing a still-connected Codex/agent socket.
- Resource-reaped sessions now get one additional timeout window to revive before the registry entry is closed; live initialized transports remain recoverable through implicit rebind.
- Implicit rebind now reuses the original initialize token through the normal `open_session` auth path instead of bypassing token validation.
- Live MCP protocol sessions now recover after external cleanup by rebinding implicit sessions on the next valid MCP request.
- Daemon ingress now closes only unbound stale sockets for cleanup; bound live sockets remain open and recoverable.
- Updated cleanup UI language to describe resource release rather than session/process shutdown.
- Updated local release identifiers from `0.5.0` to `0.5.1`.

### Verification

- `bun test local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/unit/mcp_protocol_session.test.ts local-mcp-bun/tests/integration/tool_router.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts` passed, covering `resource_reaped_at`, implicit rebind through `open_session`, daemon ingress socket recovery, and the additional timeout window.
- `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed, including unit, integration, browser E2E, fault, and concurrency coverage for live MCP cleanup recovery.
- `bun run --cwd local-mcp-bun build:popup-ui`, `bun run --cwd local-mcp-bun check:popup-ui`, `bun run --cwd local-mcp-bun lint:spec`, and `bun run --cwd local-mcp-bun release:check-version -- --version v0.5.1` passed for updated UI language, spec consistency, and local release identifiers.

## 2026-04-22

### Implemented

- Added service-authoritative stale-session cleanup with `MCP_SESSION_IDLE_TIMEOUT_MINUTES` (default `120`, `0` disables).
- Tightened session liveness tracking so valid inbound MCP traffic refreshes `last_seen_at` outside of `tools/call`.
- Added hard-reap cleanup semantics:
  - stale sessions close through one shared path,
  - queued lock waiters are cancelled by owner,
  - attach flow re-checks session liveness after waited lock acquisition and after debugger attach,
  - stale sessions cannot resurrect and attach later after being closed.
- Added daemon ingress cleanup sweeps that:
  - reap stale sessions,
  - close bound ingress sockets with `stale_session_timeout`,
  - close unbound idle ingress sockets with `stale_connection_timeout`,
  - expose `active_sessions` and `stale_session_timeout_minutes` in `/health`.
- Updated stdio proxy behavior so daemon-initiated stale cleanup closes proxy processes cleanly.
- Added direct-mode stale cleanup sweeps without auto-exiting the direct process.
- Added extension cleanup policy controls:
  - persisted timeout in `chrome.storage.local`,
  - sync-on-connect plus retry-on-heartbeat policy propagation to the service,
  - compact `Auto-cleanup` chip in the popup with modal controls for enable/disable, minutes, and `Run Cleanup Now`,
  - overdue session badges in the active sessions table.
- Added regression coverage for stale session selection, waiter cancellation, daemon ingress socket cleanup, popup cleanup view-model helpers, and waiting-session attach cancellation.

### Verification

- `./node_modules/.bin/tsc -p ./chrome-extension/tsconfig.popup.json --noEmit` passed.
- `bun test local-mcp-bun/tests/unit/config.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/unit/tab_lock_manager.test.ts local-mcp-bun/tests/unit/popup_view_model.test.ts local-mcp-bun/tests/concurrency/lock_contention.test.ts local-mcp-bun/tests/integration/tool_router.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` passed.
- `bun run --cwd local-mcp-bun build:popup-ui` passed.

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
