# Session Log: Extension reconnect illegal invocation fix

## Scope
- Investigated repeated Chrome extension reconnect failures:
  - `net::ERR_CONNECTION_REFUSED`
  - `Uncaught TypeError: Illegal invocation` from `reconnect_scheduler.schedule`
- Implemented runtime hardening for reconnect timer invocation and reconnect fallback behavior.

## Repository State
- browser_mcp: `trunk` @ `0ce1039`

## Changes made
- Updated `local-mcp-bun/chrome-extension/reconnect_scheduler.js`:
  - Replaced direct bound timer invocation with `Reflect.apply(...)` using configurable `timer_scope`.
  - Uses native timer functions as defaults while preserving invocation context safety for MV3 runtimes.
- Updated `local-mcp-bun/chrome-extension/background.js`:
  - Alarm path now schedules reconnects instead of forcing immediate `connect_bridge` calls.
  - Increased reconnect max backoff to 15s.
  - Added persistent failure log throttling (1/min once persistent failure threshold is crossed).
  - Added single-flight fallback timer when scheduler throws.
  - Clears fallback timer and scheduler-fault latch on successful reconnect.

## Verification
- `bun run test:unit` (pass)
- `bun run test:e2e` (pass)
- `bun run test:hard-gate` (pass)
- `bun run lint:spec` (pass)
- `bun run lint:compliance` (pass)

## Recent git history snapshot
- `0ce1039 fix(e2e): add windows process-only bridge fallback`
- `aca4d19 fix(e2e): tune windows launch attempt sequencing and timeouts`
- `f9ec69b ci(hard-gate): enforce full e2e matrix across all os`
- `bb3e45c fix(e2e): add resilient windows browser launch strategies`
- `be0fdb8 ci(hard-gate): use platform-aware gate runner`
- `6c3138c fix(e2e): use windows-specific extension launch settings`
- `f1df588 fix(e2e): stabilize extension roundtrip bootstrap on ci`
- `ff15370 fix(e2e): tolerate windows user-data cleanup race`
- `d4d49ad fix(compliance): normalize windows paths in self-scan exclusion`
- `dd699e2 fix(spec): make living spec path resolution cross-platform`
