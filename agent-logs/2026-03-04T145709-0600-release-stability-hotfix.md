# Session Log: Release Stability Hotfix (0.2.1)

## Repository State
- Browser-MCP: `trunk @ 71cbff1`

## Scope
- Fixed extension release package integrity to include transitive `background.js` module imports.
- Fixed compiled binary daemon auto-spawn path so default startup no longer fails with shared-daemon unavailable.
- Added release integrity tooling/tests and CI gates.
- Added bridge waiting diagnostics in extension popup/state.
- Bumped version metadata to `0.2.1`.

## Non-Mutating Validation
- Ran unit tests (including new validator + daemon spawn resolver coverage).
- Ran integration tests (`daemon_singleton_proxy` and full integration suite).
- Ran `lint:spec` and `lint:compliance`.
- Verified packaged extension zip contains:
  - `background.js`
  - `reconnect_scheduler.js`
  - `socket_attempt_lifecycle.js`
- Verified packaged Linux binary starts daemon/bridge listeners at `127.0.0.1:37778` and `127.0.0.1:37777`.

## Git Log Snapshot
- `71cbff1 docs(agent-logs): record version bump and categorical push session`
- `7e5bfb6 docs(agent-logs): record package check and daemon rollout session`
- `481db31 chore(version): bump package and extension to 0.2.0`
- `f6651be docs(runtime): document daemon model and update living spec`
- `fbefdec test(runtime): cover daemon singleton proxy and config defaults`
- `6fa4b6d feat(runtime): add shared daemon ingress and stdio proxy startup`
- `cc97a5d docs(runtime): document websocket-first defaults and v0.1.1 packaging`
- `70b7e4c chore(release): rename artifact prefix to chrome-browser-mcp`
- `94b4be2 chore(package): rename package to @TWP-Technologies/Browser-MCP`
- `991b269 chore(version): bump runtime and extension metadata to 0.1.1`

## Additional Notes
- Updated popup rapid-toggle behavior and E2E expectation to assert deterministic final-state recovery for rapid double-click intent.
- Executed full hard gate after these changes (`test:hard-gate`) with all suites passing.
