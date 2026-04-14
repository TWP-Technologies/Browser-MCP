# Browser Evaluate Schema Fix

Repository: browser_mcp
Initial branch/hash: trunk @ 1a2f0db

## Session Notes

- Started investigation for OpenAI tool registration failure:
  `mcp__browser__browser_evaluate` rejected because its parameters schema contains a top-level composition keyword.
- Browser MCP tools are intentionally not invoked during this session.
- Confirmed the source is `local-mcp-bun/src/tool_router.ts`; `browser_evaluate`, `browser_navigate`, and `browser_interact` advertised top-level `anyOf`.
- Removed top-level `anyOf` from those schemas and moved alternate-argument guidance into property descriptions. Existing runtime validation still enforces required alternate shapes.
- Added integration coverage that checks every advertised tool `inputSchema` is a top-level object and does not contain top-level `oneOf`, `anyOf`, `allOf`, `enum`, or `not`.
- Updated the living spec and changelog with the schema compatibility requirement.

## Verification

- `bun test tests/integration/tool_router.test.ts` passed.
- `bun run test:integration` passed.
- `bun run test:unit` passed.
- `bun run lint:spec` passed.
- Second review follow-up verification:
  - `bun test tests/integration/tool_router.test.ts` passed.
  - `bun test tests/integration/parity_remaining.test.ts` passed.
  - `bun run test:unit` passed.
  - `bun run test:integration` passed.
  - `LOCAL_MCP_TEST_BRIDGE_PORT=48777 bun run test:e2e` passed. Default port `37777` was occupied by an existing `chrome-browser-mcp-v0.4.1` process, so it was not terminated.
  - `bun run test:fault` passed.
  - `bun run test:concurrency` passed.
  - `bun run lint:spec` passed.

## Review Follow-up

- Published PR 12 through Graphite and waited 10 minutes for automated review.
- CodeRabbit and Copilot produced no actionable comments.
- Greptile produced two worthwhile P2 comments:
  - remove property-level composition from `browser_get_element_styles.pseudoState`;
  - wrap the updated `browser_evaluate` schema test assertions in `try/finally` so `runtime.stop()` always runs.
- Applied both comments and expanded regression coverage to reject composition keywords anywhere in advertised tool schemas while still allowing property-level `enum`.
- Submitted the follow-up branch update and waited a second 10-minute review window.
- Hard-gate CI passed on Ubuntu, macOS, and Windows. CodeRabbit and Greptile both raised the same worthwhile follow-up: `browser_get_element_styles.pseudoState` was composition-free but description-only.
- Applied the schema typing feedback by advertising `pseudoState` as a single string, adding `pseudoStates` as a string array, and normalizing both names in the in-memory transport and Chrome extension. Ignored CodeRabbit's docstring coverage warning as generic policy noise that does not match the repository's current TypeScript test style.

## Repository State

- browser_mcp: trunk @ 1a2f0db
- browser_mcp: review follow-up code on 04-14-fix_mcp_advertise_openai-compatible_tool_schemas @ 800af30
- Recent relevant commits from `git log --oneline -10`:
  - `800af30 fix(mcp): remove nested schema composition`
  - `1984785 fix(mcp): advertise OpenAI-compatible tool schemas`
  - `1a2f0db chore(release): bump version to 0.4.1`
