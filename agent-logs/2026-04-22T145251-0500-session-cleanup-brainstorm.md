# Session Cleanup Brainstorm

Repository: browser_mcp
Initial branch/hash: trunk @ fafe56e

## Session Notes

- Investigated stale agent sessions, abandoned tab locks, and long-lived packaged daemon processes in the current Browser MCP architecture.
- Confirmed the runtime already tracks `last_seen_at` per session in `session_registry`, but that timestamp is only refreshed on selected session/tool paths and there is no automatic stale-session reap.
- Confirmed session teardown currently happens on explicit `session/close`, UI-admin `close_session`, or connection close; there is no inactivity-driven close path.
- Confirmed the shared daemon only self-terminates after zero proxy connections plus `MCP_DAEMON_IDLE_TIMEOUT_MS`; orphan proxy sockets can therefore keep daemon processes alive indefinitely.
- Confirmed the extension already has:
  - a persistent `chrome.alarms` heartbeat tick,
  - `chrome.storage.local`-backed popup state for bridge port and enable/disable,
  - UI-admin request plumbing for `close_session`, `close_all_sessions`, and `detach_tab_lock`.
- Reviewed the popup layout to assess where stale-session controls could fit without increasing cognitive load. The current design already uses a dense command panel plus separate port, lock, and session panels.
- Pulled Chrome Extensions docs through Context7 to verify MV3 service-worker guidance:
  - use `chrome.alarms` instead of `setTimeout` / `setInterval` for durable periodic work,
  - persist settings/state in `chrome.storage.local`,
  - recreate/check alarms on startup because alarm persistence is not guaranteed across browser restart.
- Identified a design risk for any stale-session reaper: waiters in `tab_lock_manager` are not currently cancelled on session close, so a naive reap path could still let a stale waiting session progress into attach flow unless waiter cancellation and post-wait liveness checks are added.
- Implemented the path 3 cleanup design end-to-end:
  - added service-authoritative stale-session timeout policy (`MCP_SESSION_IDLE_TIMEOUT_MINUTES`, default `120`, `0` disables),
  - moved session activity refresh to valid MCP traffic paths instead of only `tools/call`,
  - added hard-reap close semantics that cancel queued waiters, release pending/owned locks, and re-check liveness around attach flow,
  - added daemon cleanup sweeps that close stale bound ingress sockets and unbound idle ingress sockets so abandoned proxy executables can exit,
  - added direct-mode cleanup sweeps without auto-exiting the direct stdio server,
  - added extension-side persistence/sync for the cleanup policy and a popup `Auto-cleanup` chip + modal with `Run Cleanup Now`,
  - added overdue session UI badges and health/spec/README updates.

## Verification

- Inspected:
  - `local-mcp-bun/src/session_registry.ts`
  - `local-mcp-bun/src/tool_router.ts`
  - `local-mcp-bun/src/mcp_protocol_session.ts`
  - `local-mcp-bun/src/daemon_ingress_server.ts`
  - `local-mcp-bun/src/daemon_controller.ts`
  - `local-mcp-bun/src/stdio_proxy_server.ts`
  - `local-mcp-bun/chrome-extension/background.js`
  - `local-mcp-bun/chrome-extension/popup.ts`
  - `local-mcp-bun/chrome-extension/popup.css`
  - `specs/local-multiplexed-browser-mcp-spec.md`
- Verified Chrome extension MV3 timer/storage guidance with Context7 docs for:
  - service-worker migration guidance,
  - `chrome.alarms` API behavior and persistence caveats.
- Rebuilt popup bundle:
  - `bun run --cwd local-mcp-bun build:popup-ui`
- Verified targeted TypeScript surface:
  - `cd local-mcp-bun && ./node_modules/.bin/tsc -p ./chrome-extension/tsconfig.popup.json --noEmit`
- Verified targeted tests:
  - `bun test local-mcp-bun/tests/unit/config.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/unit/tab_lock_manager.test.ts local-mcp-bun/tests/unit/popup_view_model.test.ts local-mcp-bun/tests/concurrency/lock_contention.test.ts local-mcp-bun/tests/integration/tool_router.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts`
  - `bun test local-mcp-bun/tests/unit/extension_bundle_integrity.test.ts local-mcp-bun/tests/unit/popup_motion_policy.test.ts`
  - `bun run --cwd local-mcp-bun lint:spec`
- Noted repository-wide `./node_modules/.bin/tsc -p ./tsconfig.json --noEmit` still reports many unrelated pre-existing strictness/type-environment errors outside this session’s scope (scripts, Bun/WebSocket ambient types, older exact-optional issues, Playwright typing drift).

## Repository State

- browser_mcp: trunk @ fafe56e
- browser_mcp: session-cleanup-runtime @ 2a8e98d
- browser_mcp: session-cleanup-extension @ 307cf3b
- browser_mcp: session-cleanup-docs @ b540e92
- Recent relevant commits from `git log --oneline -10`:
  - `b540e92 docs(mcp): document stale session cleanup`
  - `307cf3b feat(extension): add session auto-cleanup controls`
  - `2a8e98d feat(runtime): reap stale sessions and proxy ingress`
  - `fafe56e Merge pull request #12 from TWP-Technologies/04-14-fix_mcp_advertise_openai-compatible_tool_schemas`
  - `b79e898 fix(release): align reported version with package`
  - `2a2ba78 chore(release): bump version to 0.4.2`
  - `000e8cd docs(mcp): clarify pseudoStates string compatibility`
  - `be9aa7f fix(extension): honor string pseudoStates style filters`
