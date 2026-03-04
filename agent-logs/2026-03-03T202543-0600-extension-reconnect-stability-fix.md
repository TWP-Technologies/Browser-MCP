# Session Log: Extension Reconnect Stability Fix

- Timestamp: 2026-03-03T20:25:58-06:00
- Repository state: Browser-MCP: trunk @ 0ce1039

## Objective
Fix extension websocket reconnect instability (connection refused storms / insufficient resources) while preserving MCP correctness and recovery behavior.

## Work Completed
- Added local-mcp-bun/chrome-extension/reconnect_scheduler.js:
  - single-flight reconnect scheduling
  - capped backoff + jitter (1s -> 2s -> 4s -> 5s cap)
- Refactored local-mcp-bun/chrome-extension/background.js:
  - connection state + socket generation tracking
  - deduped reconnect scheduling
  - immediate single reconnect after previously healthy disconnect (prevents long reconnect gaps)
  - transient failures downgraded to warn/info; errors reserved for persistent/fatal conditions
  - heartbeat handling kept single-instance
- Hardened websocket transport stale-error behavior in local-mcp-bun/src/bridge_transport.ts:
  - ignore stale socket error events so active connection state is not incorrectly downgraded
- Added tests:
  - local-mcp-bun/tests/unit/reconnect_scheduler.test.ts
  - extended local-mcp-bun/tests/fault/websocket_recovery.test.ts with stale socket error regression
- Added e2e reconnect wait override for diagnostics and stability:
  - E2E_RECONNECT_WAIT_TIMEOUT_MS in local-mcp-bun/tests/e2e/extension_roundtrip.test.ts
- Updated docs:
  - local-mcp-bun/chrome-extension/README.md connection behavior + troubleshooting notes

## Verification
- bun run test:unit -> PASS
- bun run test:e2e -> PASS
- bun run test:hard-gate -> PASS
- bun run lint:spec -> PASS
- bun run lint:compliance -> PASS

## Git Snapshot
0ce1039 fix(e2e): add windows process-only bridge fallback
aca4d19 fix(e2e): tune windows launch attempt sequencing and timeouts
f9ec69b ci(hard-gate): enforce full e2e matrix across all os
bb3e45c fix(e2e): add resilient windows browser launch strategies
be0fdb8 ci(hard-gate): use platform-aware gate runner
6c3138c fix(e2e): use windows-specific extension launch settings
f1df588 fix(e2e): stabilize extension roundtrip bootstrap on ci
ff15370 fix(e2e): tolerate windows user-data cleanup race
d4d49ad fix(compliance): normalize windows paths in self-scan exclusion
dd699e2 fix(spec): make living spec path resolution cross-platform
