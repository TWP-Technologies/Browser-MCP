# Browser-MCP stacked PR retrospective

- Repository: `Browser-MCP`
- Branch state during audit: `trunk @ c971905`
- Scope: PRs `#1` through `#5`
- Audit basis:
  - GitHub review timestamps and review comments from `gh api`
  - Final merged code on `trunk`
  - Stack commit history on local branches
- Important process note:
  - The technical audit below is separate from process compliance.
  - PRs `#3` and `#4` received Copilot reviews after merge.
  - No Greptile review comments were found in the audited PR metadata.

## PR #1

- Title: `feat(extension): add llm-oriented element refs and interactions`
- Created: `2026-03-17T09:40:30Z`
- Merged: `2026-03-17T11:05:08Z`
- Relevant commits on branch before merge:
  - `24082ac` `feat(extension): add llm-oriented element refs and interactions`
  - `7cf5080` `fix(extension): address automated review findings`
  - `edbf69b` `test(e2e): skip direct screenshot on windows without cdp`
  - `c0ca1a2` `fix(extension): align remaining review follow-ups`
  - `336e211` `fix(transport): avoid websocket attach regression`
  - `9f496a3` `fix(transport): reject missing tabs in bridge helpers`

### Valid and fixed in PR #1

- Element-ref revision cleanup on detach.
  - Fixed in `7cf5080`.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js), [bridge_transport.ts](local-mcp-bun/src/bridge_transport.ts)
- `LOCAL_MCP_TEST_BRIDGE_PORT` validation in the touched tests.
  - Fixed in `7cf5080` for the PR #1 test surfaces.
  - Final evidence: [tool_router.test.ts](local-mcp-bun/tests/integration/tool_router.test.ts), [mcp_stdio_protocol_compat.test.ts](local-mcp-bun/tests/integration/mcp_stdio_protocol_compat.test.ts), [extension_roundtrip.test.ts](local-mcp-bun/tests/e2e/extension_roundtrip.test.ts)
- Selector escaping for IDs and attribute-based selectors.
  - Fixed in `7cf5080`.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- Fill-form handling when a field lacks a selector or element ref.
  - Fixed in `7cf5080` by preserving `undefined` and returning per-field failure instead of issuing `querySelector("")`.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- Forced pseudo-state cleanup after style inspection.
  - Fixed in `7cf5080` with cleanup in `finally`.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- Element-ref invalidation on browser-side navigation events.
  - Fixed in `7cf5080` by resetting refs from runtime listeners instead of only MCP navigation paths.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- Tool-neutral websocket error fallback and runtime validation of structured error codes.
  - Fixed in `7cf5080`.
  - Final evidence: [bridge_transport.ts](local-mcp-bun/src/bridge_transport.ts), [errors.ts](local-mcp-bun/src/errors.ts)
- `browser_interact` schema now advertises the fields the runtime actually accepts.
  - Fixed in `7cf5080`.
  - Final evidence: [tool_router.ts](local-mcp-bun/src/tool_router.ts)
- In-memory transport now rejects tool calls for unknown tabs instead of synthesizing success.
  - Fixed in `9f496a3`.
  - Final evidence: [bridge_transport.ts](local-mcp-bun/src/bridge_transport.ts), [in_memory_bridge_transport.test.ts](local-mcp-bun/tests/integration/in_memory_bridge_transport.test.ts)
- Radio-group selector escaping in form filling.
  - Fixed in `c0ca1a2`.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- Detach/reattach state reset in the in-memory transport.
  - Fixed across the PR #1 follow-up commits.
  - Final evidence: [bridge_transport.ts](local-mcp-bun/src/bridge_transport.ts)

### Valid but only fixed later

- None of the high-confidence PR #1 bot findings required PR #5 for correctness. The meaningful fixes landed on the PR #1 branch before merge.

### Invalid or low-value noise

- None of the substantive PR #1 bot findings were obvious noise. The main comments mapped to real correctness issues.

### Still concerning after the full stack landed

- `browser_lookup` element refs are still not guaranteed to resolve a unique node.
  - Why: `register_element_ref()` stores descriptor metadata, but `resolve_selector_target()` still replays only `entry.selector`. The extra metadata is not used for resolution, so a lightweight selector can still drift to the wrong node if it is non-unique.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- Snapshot / lookup DOM scan cost is still high on large pages.
  - Why: the extension still walks broad DOM sets and computes layout/style data per element before truncation.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- The E2E fixture server still probes a fixed port range that can conflict with a user-selected bridge port.
  - Why: the bridge port is configurable, but the fixture server still uses a hard-coded scan range.
  - Final evidence: [extension_roundtrip.test.ts](local-mcp-bun/tests/e2e/extension_roundtrip.test.ts)

## PR #2

- Title: `feat(extension): add interaction and navigation parity`
- Created: `2026-03-17T09:40:31Z`
- Merged: `2026-03-17T11:14:00Z`
- Relevant commits on branch before merge:
  - `80a8010` `feat(extension): add interaction and navigation parity`
  - `2a6276b` `fix(extension): align interaction parity edge cases`

### Valid and fixed in PR #2

- `browser_interact` with `onError: "ignore"` must preserve one result per action.
  - Fixed in `2a6276b`.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js), [bridge_transport.ts](local-mcp-bun/src/bridge_transport.ts), [tool_router.test.ts](local-mcp-bun/tests/integration/tool_router.test.ts)
- In-memory `browser_tabs action="new"` must preserve the current active tab when `activate=false`.
  - Fixed in `2a6276b`.
  - Final evidence: [bridge_transport.ts](local-mcp-bun/src/bridge_transport.ts), [in_memory_bridge_transport.test.ts](local-mcp-bun/tests/integration/in_memory_bridge_transport.test.ts)
- In-memory `browser_navigate` must reject unsupported history actions instead of returning success.
  - Fixed in `2a6276b`.
  - Final evidence: [bridge_transport.ts](local-mcp-bun/src/bridge_transport.ts), [in_memory_bridge_transport.test.ts](local-mcp-bun/tests/integration/in_memory_bridge_transport.test.ts)
- `browser_tabs action="new"` index reporting now aligns with the list snapshot semantics.
  - Fixed in `2a6276b` by returning the created tab's snapshot index when available.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- `browser_tabs set_stealth` now returns a structured `INVALID_ARGUMENT` error when `tab_id` is missing.
  - Fixed in `80a8010`.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js), [bridge_transport.ts](local-mcp-bun/src/bridge_transport.ts)

### Valid but only fixed later

- None identified. The meaningful PR #2 bot findings were fixed on the PR #2 branch before merge.

### Invalid or low-value noise

- None identified.

### Still concerning after the full stack landed

- No high-confidence unresolved PR #2 bot findings remain.

## PR #3

- Title: `feat(extension): close remaining parity gaps`
- Created: `2026-03-17T09:40:33Z`
- Merged: `2026-03-17T11:15:20Z`
- Relevant branch commit before merge:
  - `7fb53e7` `feat(extension): close remaining parity gaps`
- Important process note:
  - Copilot's review for this PR landed at `2026-03-17T11:20:06Z`, after merge.

### Valid but only fixed later

- Test bridge port parsing in the new parity tests.
  - Fixed later in PR #5.
  - Final evidence: [parity_remaining.test.ts](local-mcp-bun/tests/integration/parity_remaining.test.ts), [extension_roundtrip.test.ts](local-mcp-bun/tests/e2e/extension_roundtrip.test.ts)
- `browser_evaluate` schema should require `expression` or `function`.
  - Fixed later in PR #5.
  - Final evidence: [tool_router.ts](local-mcp-bun/src/tool_router.ts), [tool_router.test.ts](local-mcp-bun/tests/integration/tool_router.test.ts)
- Artifact persistence was an arbitrary file write primitive without workspace containment.
  - Fixed later in PR #5, then hardened further against symlink escape.
  - Final evidence: [tool_router.ts](local-mcp-bun/src/tool_router.ts), [parity_remaining.test.ts](local-mcp-bun/tests/integration/parity_remaining.test.ts)
- Replay path lacked try/catch and safe header filtering.
  - Fixed later in PR #5.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- Opacity parsing for visibility should be numeric, not string equality.
  - Fixed later in PR #5.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)

### Still concerning after the full stack landed

- The extension still eagerly fetches and stores response bodies for every finished request on attached tabs.
  - Why: `Network.loadingFinished` still attempts `Network.getResponseBody` immediately, which can grow memory and CPU cost on network-heavy pages.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)

## PR #4

- Title: `docs(agent-logs): record parity closeout sessions`
- Created: `2026-03-17T09:40:35Z`
- Merged: `2026-03-17T11:16:37Z`
- Relevant branch commit before merge:
  - `55b8b26` `docs(agent-logs): record parity closeout sessions`
- Important process note:
  - Copilot's review for this PR landed at `2026-03-17T11:18:00Z`, after merge.

### Technical retrospective

- No actionable technical bot findings were attached to PR #4. The bot output was a summary-only review of documentation/log files.

## PR #5

- Title: `fix(extension): address post-merge bot followups`
- Created: `2026-03-17T11:33:21Z`
- Merged: `2026-03-17T11:49:45Z`
- Relevant commits before merge:
  - `7149e50` `fix(extension): address post-merge bot followups`
  - `f8cb742` `test(e2e): use loopback fixture for direct screenshots`
  - `71baebf` `fix(extension): harden artifact persistence`

### Valid and fixed in PR #5

- Absolute-path traversal hardening and test coverage.
  - Final evidence: [tool_router.ts](local-mcp-bun/src/tool_router.ts), [parity_remaining.test.ts](local-mcp-bun/tests/integration/parity_remaining.test.ts)
- Symlink-based workspace escape on artifact writes.
  - Final evidence: [tool_router.ts](local-mcp-bun/src/tool_router.ts)
- Replay header sanitization prototype-safety.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)
- Shared artifact-output helper for test temp directories.
  - Final evidence: [artifact_output.ts](local-mcp-bun/tests/helpers/artifact_output.ts), [parity_remaining.test.ts](local-mcp-bun/tests/integration/parity_remaining.test.ts), [extension_roundtrip.test.ts](local-mcp-bun/tests/e2e/extension_roundtrip.test.ts)
- Living-spec / changelog status update for the router contract change.
  - Final evidence: [local-multiplexed-browser-mcp-changelog.md](specs/local-multiplexed-browser-mcp-changelog.md)
- Direct screenshot E2E moved from `data:` to loopback HTTP.
  - Final evidence: [extension_screenshot_direct.test.ts](local-mcp-bun/tests/e2e/extension_screenshot_direct.test.ts)

### Invalid or low-value noise

- “Add the required `Modified by [KnotFalse]` notice” on individual TypeScript test/helper files.
  - In the actual repository context, this is not enforced consistently across touched TypeScript files and does not identify a correctness or behavior defect.

### Still concerning after the full stack landed

- Visibility logic is still inconsistent across tools.
  - Why: the numeric opacity fix landed in some visibility code paths, but there is still duplicated visibility logic rather than one shared helper used consistently by wait, verify, overlay, snapshot, and lookup.
  - Final evidence: [background.js](local-mcp-bun/chrome-extension/background.js)

## Overall codebase-context conclusion

- PR #1 and PR #2 did absorb most of the meaningful early bot feedback before merge, but PR #1 still has unresolved structural issues around element-ref uniqueness, DOM-scan cost, and the E2E fixture-port strategy.
- PR #3 was the weak point technically and procedurally:
  - several valid security and contract issues were only fixed later in PR #5
  - the only high-confidence remaining technical concern from that area is eager response-body capture
- PR #4 was process-noisy but technically trivial
- PR #5 was the corrective cleanup PR and fixed most of the real post-merge issues, but it did not fully normalize visibility logic across all extension tools

## Follow-up

- PR #6 addresses the remaining high-confidence concerns identified in this retrospective:
  - fail-closed `element_ref` replay
  - lazy response-body fetching with bounded caching
  - bounded snapshot/lookup scanning
  - shared loopback allocation instead of fixed fixture-port probing

## Relevant recent history

```text
c971905 fix(extension): address post-merge bot followups
71baebf fix(extension): harden artifact persistence
f8cb742 test(e2e): use loopback fixture for direct screenshots
7149e50 fix(extension): address post-merge bot followups
432a7c9 docs(agent-logs): record parity closeout sessions
55b8b26 docs(agent-logs): record parity closeout sessions
78ef38b feat(extension): close remaining parity gaps
7fb53e7 feat(extension): close remaining parity gaps
dfe93f3 feat(extension): add interaction and navigation parity
2a6276b fix(extension): align interaction parity edge cases
```
