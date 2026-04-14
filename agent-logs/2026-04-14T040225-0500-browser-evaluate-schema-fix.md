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

## Review Follow-up

- Published PR 12 through Graphite and waited 10 minutes for automated review.
- CodeRabbit and Copilot produced no actionable comments.
- Greptile produced two worthwhile P2 comments:
  - remove property-level composition from `browser_get_element_styles.pseudoState`;
  - wrap the updated `browser_evaluate` schema test assertions in `try/finally` so `runtime.stop()` always runs.
- Applied both comments and expanded regression coverage to reject composition keywords anywhere in advertised tool schemas while still allowing property-level `enum`.

## Repository State

- browser_mcp: trunk @ 1a2f0db
- browser_mcp: review follow-up code on 04-14-fix_mcp_advertise_openai-compatible_tool_schemas @ 800af30
- Recent relevant commits from `git log --oneline -10`:
  - `800af30 fix(mcp): remove nested schema composition`
  - `1984785 fix(mcp): advertise OpenAI-compatible tool schemas`
  - `1a2f0db chore(release): bump version to 0.4.1`
