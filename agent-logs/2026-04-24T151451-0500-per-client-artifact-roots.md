# Per-Client Artifact Roots

Repo: browser_mcp
Branch: per-client-artifact-roots
Base: trunk @ 91cf8f8

## Goal

Implement per-agent artifact roots for Browser MCP so screenshot/PDF `path` writes in shared-daemon mode resolve against the calling MCP client process cwd, not the daemon cwd.

## Implementation Notes

- Added an artifact-root helper for canonical root resolution, workspace-bound path validation, and destination preparation.
- Threaded `client_artifact_root` from the stdio proxy URL into daemon ingress WebSocket data, then into MCP session creation.
- Stored per-session artifact-root context in registry-private metadata so exported session snapshots do not expose local paths.
- Updated screenshot/PDF persistence to resolve paths from the calling session's artifact root.
- Follow-up PR review fixes gated `client_artifact_root` to loopback daemon ingress or authenticated shared daemons, kept remote proxy URLs from sending cwd metadata by default, preserved existing `tool_error` instances during artifact persistence, and made missing-root failures descriptive.
- Second review loop fix bases proxy cwd-metadata attachment on the daemon-reported bind host so a proxy connecting through `127.0.0.1` to a daemon bound on `0.0.0.0` does not send metadata that ingress will reject.
- Third review loop fix stops auto-attaching client cwd metadata to authenticated non-loopback daemons unless `MCP_ATTACH_CLIENT_ARTIFACT_ROOT=1`/`true` is explicitly set.
- Fourth review loop fix validates artifact parent path segments before creating directories so parent symlinks cannot escape the artifact root, and defers non-loopback artifact-root filesystem checks until after initialize token validation.
- Fifth review loop fix handles `EEXIST` races during segment-by-segment artifact directory creation and adds `MCP_ATTACH_CLIENT_ARTIFACT_ROOT=0`/`false` as an explicit loopback attachment opt-out for tunneled remote daemons.
- Sixth review loop fix revalidates the session artifact root against its original canonical path before any root-level artifact write, so replacing the root path with a symlink after session creation cannot redirect screenshots or PDFs.
- Seventh review loop fix adds a daemon-issued artifact-root token, stores it in owner-scoped daemon state, has stdio proxies attach it with cwd metadata, and rejects untrusted `client_artifact_root` inputs before filesystem validation.
- Eighth review loop fix redacts artifact-root metadata from proxy connection errors and falls back to daemon-cwd artifact paths when daemon state is missing the artifact-root token.
- Ninth review loop fix validates daemon state against daemon health before using an artifact-root token, so stale or mismatched state degrades to daemon-cwd artifact paths.
- Tenth review loop fix falls back to the OS temp directory when the daemon launch cwd has been deleted, preserving non-artifact MCP connectivity.
- Eleventh review loop fix skips proxy artifact-root attachment when the client cwd is unavailable and skips the deleted-cwd regression on Windows where the process cwd cannot be removed.
- Twelfth review loop fix wraps artifact-root revalidation filesystem races so deleted roots produce artifact validation errors instead of raw filesystem exceptions.
- Thirteenth review loop fix strips artifact-root URL params when attachment is disabled, requires daemon-state host matches before token reuse, and moves artifact-root paths out of the exported session shape.
- Fourteenth review loop fix fails proxy startup when per-client attachment was expected but the token is missing or stale, normalizes more artifact path races, allows dot-prefixed child paths, and writes daemon state via a private temp file plus rename.
- Fifteenth review loop fix removes the redundant post-rename daemon-state chmod, updates final storage-model wording, and logs cwd-unavailable fallback for implicit loopback attachment.
- Sixteenth review loop fix treats loopback daemon host aliases as equivalent during state-token reuse and compares artifact-root tokens with timing-safe equality.
- Seventeenth review loop fix adds the required modification notice to the updated stdio proxy source file.
- Eighteenth review loop fix adds the required modification notice to the new artifact helper source file.
- Nineteenth review loop fix maps deferred artifact-root resolution failures to `INVALID_ARGUMENT` and writes artifacts through a no-follow file open on POSIX.
- Twentieth review loop fix updates the fallback docs, rejects directory artifact targets, validates cached auto-auth tokens against daemon state, and clones artifact-root context at the registry boundary.
- Twenty-first review loop fix revalidates walked artifact parents immediately before nested directory creation and preserves explicit artifact-root URL metadata when proxy cwd is unavailable.
- Twenty-second review loop fix includes daemon start time in daemon-state secret reuse checks, adds modification notices to modified source files, qualifies daemon-cwd fallback docs, and revalidates artifact parents after file open before mutation.
- CI follow-up gives the process-spawning daemon singleton integration test an explicit 20s timeout and makes daemon state share the ingress start timestamp so the started-at freshness check is stable across slower runners.
- Twenty-third review loop fix persists daemon state only after ingress binds, clones object-form protocol artifact roots, and adds modification notices to modified tests.
- Twenty-fourth review loop fix makes proxies wait for matching persisted daemon state before deriving artifact-root tokens, while keeping state persistence after ingress bind, and makes daemon teardown continue even if best-effort state refresh fails.
- Twenty-fifth review loop fix extends the daemon shutdown polling window to match the test budget and centralizes artifact-root context cloning in the shared artifact helper.
- Twenty-sixth review loop fix avoids delaying proxy startup solely for optional auto-auth state logging when artifact-root attachment is disabled.
- Twenty-seventh review loop fix reports raw artifact persistence I/O failures as `TOOL_FAILED` and restores the original `process.cwd` descriptor in stdio proxy tests.
- Twenty-eighth review loop fix caps combined daemon health and state polling to the advertised connect timeout and clears delayed state writer timers before test cleanup.
- Twenty-ninth review loop fix writes artifacts through a same-directory temp file plus final rename, preserves captured screenshot payloads when post-capture artifact-root lookup races session cleanup, gives the daemon singleton test more timeout headroom, and makes stale daemon-state token failures name the state path and recovery options.
- Thirtieth review loop fix applies CodeRabbit's changelog wording correction and records the latest artifact-write/session-race behavior in the living spec changelog.
- Thirty-first local review fix allows nested artifact directory creation under a symlinked artifact root that was already accepted and pinned by realpath, while preserving rejection for symlinks below the root.
- Thirty-second review loop fix waits for matching daemon state when auto-auth is requested by an auth-enabled daemon, and overwrites stale artifact-root URL tokens with the current daemon-issued token.
- Thirty-third review loop fix anchors Linux artifact finalization to the opened parent directory, pins deferred artifact roots across implicit MCP session rebinds, and preserves `saved: false` artifact fallback responses if session cleanup races the post-call recovery mark.
- Thirty-fourth review loop fix documents the non-Linux fd-relative filesystem limitation in code and adds an explicit dated changelog note tying the README updates to the living spec.
- Updated living spec, changelog, and local README to document per-client artifact persistence.

## Verification

- `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts` passed.
- `bun test local-mcp-bun/tests/integration/tool_router.test.ts local-mcp-bun/tests/integration/mcp_stdio_protocol_compat.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` passed.
- `bun run --cwd local-mcp-bun lint:spec` passed.
- `bun run --cwd local-mcp-bun lint:docs` passed.
- `bun run --cwd local-mcp-bun check:popup-ui` passed.
- `bun run --cwd local-mcp-bun test:unit` passed.
- `bun run --cwd local-mcp-bun test:integration` passed.
- `bun run --cwd local-mcp-bun test:hard-gate` reached E2E and failed because the live daemon already owned default bridge port `37777`.
- `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- PR review follow-up: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts` passed.
- PR review follow-up: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `bun run --cwd local-mcp-bun check:popup-ui` passed.
- PR review follow-up: `bun run --cwd local-mcp-bun test:unit`, `bun run --cwd local-mcp-bun test:integration`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Second review loop: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` passed.
- Second review loop: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Third review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` passed.
- Third review loop: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Fourth review loop: `bun test local-mcp-bun/tests/integration/parity_remaining.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/unit/stdio_proxy_server.test.ts` passed.
- Fourth review loop: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Fifth review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts` passed.
- Fifth review loop: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Sixth review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts` passed.
- Sixth review loop: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Seventh review loop: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` passed.
- Seventh review loop: `bun test local-mcp-bun/tests/integration/parity_remaining.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Eighth review loop: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` passed.
- Eighth review loop: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Ninth review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` passed.
- Ninth review loop: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Tenth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` passed.
- Tenth review loop: `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Eleventh review loop: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twelfth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Thirteenth review loop: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/integration/tool_router.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Fourteenth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Fifteenth review loop: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/unit/artifacts.test.ts`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:spec`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed. Remote Ubuntu failure on the prior head was an E2E popup wait timeout after unit/integration tests passed.
- Sixteenth review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Seventeenth review loop: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts`, `bun run --cwd local-mcp-bun lint:compliance`, `bun run --cwd local-mcp-bun lint:docs`, and `bun run --cwd local-mcp-bun lint:spec` passed.
- Eighteenth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/stdio_proxy_server.test.ts`, `bun run --cwd local-mcp-bun lint:compliance`, `bun run --cwd local-mcp-bun lint:docs`, and `bun run --cwd local-mcp-bun lint:spec` passed.
- Nineteenth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/mcp_protocol_session.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `bun run --cwd local-mcp-bun lint:compliance` passed.
- Nineteenth review loop: `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twentieth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `bun run --cwd local-mcp-bun lint:compliance` passed.
- Twentieth review loop: `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-first review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/stdio_proxy_server.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `bun run --cwd local-mcp-bun lint:compliance` passed.
- Twenty-first review loop: `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-second review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/unit/mcp_protocol_session.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts local-mcp-bun/tests/integration/daemon_ingress_cleanup.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `bun run --cwd local-mcp-bun lint:compliance` passed.
- Twenty-second review loop: `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- CI timeout follow-up: `bun test local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts` and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-third review loop: `bun test local-mcp-bun/tests/unit/mcp_protocol_session.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-fourth review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts` passed.
- Twenty-fourth review loop: `bun test local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts` passed.
- Twenty-fourth review loop: `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-fifth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/unit/mcp_protocol_session.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-sixth review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/session_registry.test.ts local-mcp-bun/tests/unit/mcp_protocol_session.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-seventh review loop: `bun test local-mcp-bun/tests/unit/stdio_proxy_server.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-eighth review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Twenty-ninth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts local-mcp-bun/tests/unit/daemon_spawn_target.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed.
- Thirtieth review loop: `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, and `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts` passed.
- Thirty-first local review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, `cr review --agent --type uncommitted`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed. CodeRabbit CLI reported zero findings.
- Thirty-second review loop: `bun test local-mcp-bun/tests/unit/daemon_spawn_target.test.ts local-mcp-bun/tests/unit/stdio_proxy_server.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, `cr review --agent --type uncommitted`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed. CodeRabbit CLI reported zero findings.
- Thirty-third review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts local-mcp-bun/tests/unit/mcp_protocol_session.test.ts local-mcp-bun/tests/integration/parity_remaining.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, `bun run --cwd local-mcp-bun lint:compliance`, and `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run --cwd local-mcp-bun test:hard-gate` passed. `cr review --agent --type uncommitted` completed with one minor finding in existing untracked `local-mcp-bun/.tmp/browser_mcp_release_smoke.ts`, outside the PR diff.
- Thirty-fourth review loop: `bun test local-mcp-bun/tests/unit/artifacts.test.ts`, `git diff --check`, `bun run --cwd local-mcp-bun lint:spec`, `bun run --cwd local-mcp-bun lint:docs`, and `bun run --cwd local-mcp-bun lint:compliance` passed.

## Relevant Git History

```text
91cf8f8 docs(agent-logs): record 0.5.2 release bump
a0ff9e4 chore(release): bump version to 0.5.2
72299b1 fix(mcp): keep stale cleanup transports recoverable (#17)
a1929bb fix(mcp): keep stale cleanup transports recoverable
92291a6 chore(release): bump version to 0.5.0
e83dad7 Merge pull request #16 from TWP-Technologies/session-cleanup-log
af34894 docs(agent-logs): note top-stack log update
5eab7b7 docs(agent-logs): record session cleanup review loop
89e28ff docs(agent-logs): record stale cleanup stack
61b3d5d Merge pull request #15 from TWP-Technologies/session-cleanup-docs
```
