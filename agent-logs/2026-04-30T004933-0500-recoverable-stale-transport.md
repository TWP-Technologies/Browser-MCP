# Recoverable Stale Transport Cleanup

## Goal

Explain and fix why long-running Browser MCP agents could still see `Transport closed` days after the v0.6.0 upgrade, despite the earlier stale-daemon mismatch being gone.

## Assumptions Checked

- Current v0.6.0 is not the old mixed-version daemon issue.
- The relevant failure path is a long-lived initialized MCP transport whose session registry entry was soft-reaped and later removed.
- Cleanup must still reclaim genuinely abandoned pre-initialize daemon ingress sockets.

## Files Changed

- `local-mcp-bun/src/mcp_protocol_session.ts`
- `local-mcp-bun/src/daemon_ingress_server.ts`
- `local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts`
- `local-mcp-bun/README.md`
- `specs/local-multiplexed-browser-mcp-spec.md`
- `specs/local-multiplexed-browser-mcp-changelog.md`

## Decisions

- Added an explicit protocol-session predicate for recoverable initialized state.
- Daemon ingress now skips stale unbound socket closure when that connection still has recoverable initialized state.
- The cleanup policy remains bounded: stale unbound sockets without initialized recoverable state still close on timeout.
- Spec and README now distinguish recoverable initialized MCP transports from pre-initialize proxy leaks.

## Validation

- `bun test local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts` -> 9 pass.
- `bun test local-mcp-bun/tests/unit/mcp_protocol_session.test.ts` -> 13 pass.
- `bun run --cwd local-mcp-bun lint:spec` -> pass.
- `bun run --cwd local-mcp-bun lint:docs` -> pass.
- `bun run --cwd local-mcp-bun lint:compliance` -> pass.
- `git diff --check` -> pass.

## Git State

- Current branch head before finalization: `cdcf22d chore(release): bump version to 0.6.0`.
- Existing unrelated untracked files were left untouched.
- PR branch: `codex/recoverable-stale-transport`.

## Remaining Risk

- This is local deterministic coverage of the daemon/protocol lifecycle. A live long-running external harness should no longer need a session restart after its stale resource entry is removed, but that exact harness behavior depends on it keeping the underlying stdio/WebSocket process alive.

## Version Bump And Linux Build

- Updated release/runtime version surfaces from `0.6.0` to `0.6.1`:
  - `local-mcp-bun/package.json`
  - `local-mcp-bun/chrome-extension/manifest.json`
  - `local-mcp-bun/src/mcp_protocol_session.ts`
  - `local-mcp-bun/src/bridge_transport.ts`
- `bun run --cwd local-mcp-bun release:check-version -- --version v0.6.1` -> pass.
- `bun run --cwd local-mcp-bun package:release -- --mode=server --version v0.6.1 --clean` -> produced `local-mcp-bun/dist/release/v0.6.1/chrome-browser-mcp-v0.6.1-linux-x64`.
- Packaged binary smoke initialize with `BRIDGE_MODE=in_memory MCP_DAEMON_MODE=direct` returned `serverInfo.version="0.6.1"`.
- SHA256: `315650bd6d27cab2feec227ef128974786c3de16262d3cb1f6c5ae398d2cfee3`.
