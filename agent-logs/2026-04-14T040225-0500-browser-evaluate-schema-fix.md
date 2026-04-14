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

## Repository State

- browser_mcp: trunk @ 1a2f0db
- Recent relevant commits from `git log --oneline -10`: no new commits during this session; latest remains `1a2f0db chore(release): bump version to 0.4.1`.
