# Session Log: Public README + Privacy Docs Implementation

## Repository State
- Browser-MCP: `trunk @ 3ac8e7f`

## Scope
- Added canonical root `README.md` for open-source onboarding and SEO-aware positioning.
- Added root `PRIVACY.md` suitable for Chrome Web Store Privacy tab linking.
- Updated `local-mcp-bun/README.md` to point users to root docs for install/privacy.
- Added `local-mcp-bun/scripts/validate_public_docs.ts` docs guard and unit tests.
- Wired docs validation into package scripts, `justfile`, and CI workflow.

## Validation
- `bun run lint:docs`
- `bun run test:unit`
- `bun run lint:spec`
- `bun run lint:compliance`

## Git Log Snapshot
- `3ac8e7f docs(agent-logs): record categorical commit and push session`
- `98ee1b0 test(e2e): handle disable modal during toggle stress checks`
- `18b7f40 docs(agent-logs): record popup disable/detach implementation session`
- `dee6934 chore(version): bump browser mcp to 0.2.2`
- `d03097e feat(extension): add disable modal flow and popup width updates`
- `756b23b feat(runtime): add admin close-all and lock-detach actions`
- `6070749 docs(agent-logs): refresh branch hash and commit snapshot`
- `e82c31c docs(agent-logs): record 0.2.1 release stabilization session`
- `dcf434b feat(extension): add bridge waiting diagnostics and robust toggle UX`
- `bc3f307 fix(runtime): harden daemon bootstrap and release artifact checks`
