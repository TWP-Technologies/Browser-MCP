# Follow-up parity concerns implementation

- Repository: `Browser-MCP`
- Branch/state: `trunk @ c971905`
- Scope:
  - fail-closed `element_ref` replay
  - lazy, bounded network response-body capture
  - unified visibility semantics across extension tools
  - bounded snapshot/lookup candidate scanning
  - shared loopback-port allocator for E2E fixtures

## Changes

- Extension runtime:
  - tightened `element_ref` resolution to prefer `unique_selector` and otherwise require a unique fingerprint match before replay
  - snapshot and lookup now emit richer selector descriptors and use bounded two-phase candidate scanning
  - network request capture is metadata-first; response bodies are fetched lazily on `action=details` and only cached when text-like and within size budget
  - visibility checks were normalized across wait, overlay, snapshot, lookup, and verify-element-visible
  - `browser_network_requests action=list` now strips cached response body fields from list output
- In-memory bridge:
  - widened stored `element_ref` entries from raw selectors to replay descriptors
  - fail-closed stale handling for non-replayable refs
  - `browser_network_requests action=list` remains metadata-only while `action=details` returns body text explicitly
- Test harness:
  - added shared loopback Bun-server helper using Node `net` reserved ports
  - roundtrip and direct screenshot E2E suites now use the shared allocator instead of fixed probe ranges
- Living spec:
  - documented fail-closed `element_ref` behavior and metadata-only network listing
  - changelog updated for the runtime and harness contract changes

## Validation

- `node --check local-mcp-bun/chrome-extension/background.js`
- `bun test ./local-mcp-bun/tests/integration/in_memory_bridge_transport.test.ts ./local-mcp-bun/tests/integration/tool_router.test.ts ./local-mcp-bun/tests/integration/parity_remaining.test.ts ./local-mcp-bun/tests/integration/mcp_stdio_protocol_compat.test.ts`
- `LOCAL_MCP_TEST_BRIDGE_PORT=37879 bun test ./local-mcp-bun/tests/e2e/extension_roundtrip.test.ts --timeout 120000`
- `bun test ./local-mcp-bun/tests/e2e/extension_screenshot_direct.test.ts --timeout 120000`

## Notes

- The first visibility-helper implementation attempted to inject one shared helper source into each page-context callback. That was brittle in the live Chromium execution path, so the final implementation uses the same normalized visibility predicate inline at each relevant callback site instead.
- No repo-tracked files were reformatted beyond the direct functional edits above.

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
