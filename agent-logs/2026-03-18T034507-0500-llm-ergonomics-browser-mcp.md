# Session Log: LLM ergonomics hardening for Browser MCP

- Repository: browser_mcp
- Repository state reference: browser_mcp: trunk @ 573c7d0
- Session focus: investigate live harness misuse by an LLM consumer, harden the MCP surface for model ergonomics without broad permissiveness, and validate the result with integration + real-extension tests.

## What changed

- Added MCP prompt support and onboarding guidance surfaces:
  - `prompts/list`
  - `prompts/get`
  - prompts: `learn_browser_mcp`, `attach_and_observe`, `network_debug_flow`
- Added fallback help tool:
  - `learn_browser_mcp`
- Tightened tool discoverability in `tools/list` for:
  - `attach_to_tab`
  - `detach_from_tab`
  - `browser_tabs`
  - `browser_navigate`
  - `browser_network_requests`
- Added narrow ergonomic affordances:
  - `browser_navigate` infers `action='url'` when only `url` is provided
  - `browser_network_requests` accepts `request_id` as an alias for `requestId`
  - `detach_from_tab` infers `tab_id` only when the session owns exactly one tab
- Added richer correction hints in MCP tool error text and structured payloads.
- Updated living spec and changelog for the new onboarding and ergonomic behavior.

## Why

The live release smoke harness initially misused the MCP in exactly the ways a frontier model is likely to misuse it:

- omitted `action` for URL navigation
- used `request_id` instead of `requestId`
- assumed `detach_from_tab` would infer the current tab

That was not random operator error. It exposed predictable friction between strict but under-taught tool contracts and the priors LLMs bring to browser/navigation/network APIs.

## Validation

Ran:

- `bun test ./local-mcp-bun/tests/integration/mcp_stdio_protocol_compat.test.ts ./local-mcp-bun/tests/integration/parity_remaining.test.ts ./local-mcp-bun/tests/integration/tool_router.test.ts ./local-mcp-bun/tests/integration/in_memory_bridge_transport.test.ts`
- `LOCAL_MCP_TEST_BRIDGE_PORT=37879 bun test ./local-mcp-bun/tests/e2e/extension_roundtrip.test.ts --timeout 120000`

Observed:

- Integration: `46 pass`, `0 fail`
- Real extension roundtrip E2E: `4 pass`, `0 fail`

## Working tree at end of session

Modified tracked files:

- `local-mcp-bun/README.md`
- `local-mcp-bun/src/mcp_protocol_session.ts`
- `local-mcp-bun/src/tool_router.ts`
- `local-mcp-bun/tests/e2e/extension_roundtrip.test.ts`
- `local-mcp-bun/tests/integration/mcp_stdio_protocol_compat.test.ts`
- `local-mcp-bun/tests/integration/parity_remaining.test.ts`
- `specs/local-multiplexed-browser-mcp-changelog.md`
- `specs/local-multiplexed-browser-mcp-spec.md`

Untracked:

- `local-mcp-bun/.tmp/`

## Relevant recent history

```text
573c7d0 chore(release): bump version to 0.3.0
b886fcc docs(agent-logs): capture PR #7 fifth review cycle
4cd261b test(integration): tighten ambiguous lookup fixture dispatch
3842b76 docs(agent-logs): capture PR #7 fourth review cycle
68f78eb test(integration): harden network list assertions
fc477f3 docs(agent-logs): capture PR #7 third review cycle
823db9e test(e2e): harden network details assertions
66dd977 docs(agent-logs): update PR #7 review follow-up
97ff776 fix(extension): sanitize in-memory network list results
1f35696 docs(agent-logs): record PR #7 greptile follow-up
```
