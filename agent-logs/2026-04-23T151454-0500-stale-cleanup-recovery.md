# Session Log: Stale Cleanup Recovery

- Date: 2026-04-23 15:14:54 -0500
- Repository: Browser-MCP
- Scope: Fix v0.5.0 stale cleanup so long-running Codex/agent transports remain recoverable after browser resources are released.

## Work In Progress

- Investigated the current stale cleanup lifecycle around `session_registry`, `tool_router`, `mcp_protocol_session`, daemon ingress, and popup cleanup UI.
- Implementing browser-resource soft reap for stale sessions while preserving explicit hard-close behavior for client disconnects and manual session close.

## Branch And Commit State

- Browser-MCP: Graphite branch `04-23-fix-stale-cleanup-transport-recovery`, based on `trunk` @ `92291a6`.
- Commit title: `fix(mcp): keep stale cleanup transports recoverable`.

## Work Completed

- Changed stale-session cleanup to release browser resources without closing still-live MCP transports.
- Added `resource_reaped_at` session metadata so stale cleanup is idempotent until the next valid MCP request.
- MCP protocol sessions now rebind implicit sessions after external cleanup while keeping explicit stale `agent_session_id` calls strict.
- Daemon ingress cleanup unbinds missing session bindings without closing the socket, while unbound idle sockets remain eligible for cleanup.
- Refreshed popup cleanup copy/state handling, living spec, changelog, and release identifiers for `v0.5.1`.

## Verification

- `bun test local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/unit/mcp_protocol_session.test.ts local-mcp-bun/tests/unit/popup_view_model.test.ts`
- `bun test local-mcp-bun/tests/integration/tool_router.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts`
- `bun run --cwd local-mcp-bun check:popup-ui`
- `bun run --cwd local-mcp-bun build:popup-ui`
- `bun run --cwd local-mcp-bun release:check-version -- --version v0.5.1`
- `bun run --cwd local-mcp-bun lint:spec`
- `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate`
- `git diff --check`

## Recent Relevant History

- `92291a6 chore(release): bump version to 0.5.0`
- `e83dad7 Merge pull request #16 from TWP-Technologies/session-cleanup-log`
- `af34894 docs(agent-logs): note top-stack log update`
- `5eab7b7 docs(agent-logs): record session cleanup review loop`
- `89e28ff docs(agent-logs): record stale cleanup stack`
- `61b3d5d Merge pull request #15 from TWP-Technologies/session-cleanup-docs`
- `73270f9 docs(mcp): align cleanup spec metadata`
- `67be522 docs(mcp): tighten cleanup spec components`
- `cf37be2 docs(mcp): document stale session cleanup`
- `9bafc6c Merge pull request #14 from TWP-Technologies/session-cleanup-extension`
