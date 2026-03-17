# Post-merge bot feedback follow-up

- Date: 2026-03-17
- Repository: Browser-MCP
- Starting point: trunk @ 432a7c9
- Scope: Validate unresolved automated review comments left on merged PR #1 and determine whether a follow-up branch/PR is warranted.

## Notes
- The original PR stack is already merged; there is no open bottom PR to patch in place.
- Any remaining valid review findings must be handled as a new follow-up diff off `trunk`.

## Applied fixes
- Constrained screenshot/PDF artifact persistence paths to stay within the current workspace.
- Added `browser_evaluate` schema requirements so `expression` or `function` is required at the tool contract layer.
- Hardened network replay by filtering forbidden headers, suppressing bodies for GET/HEAD, and surfacing replay failures as structured tool errors.
- Normalized visibility checks to treat numeric opacity values like `0.0` as hidden.
- Reused validated `LOCAL_MCP_TEST_BRIDGE_PORT` parsing in `parity_remaining.test.ts`.
- Moved artifact persistence tests to a workspace-local temp directory and added a rejection test for traversal outside the workspace.
- Branch created: Browser-MCP: 03-17-fix_post_merge_bot_followups @ 7149e50
- CI follow-up: fixed `extension_screenshot_direct.test.ts` to use a loopback HTTP fixture instead of a `data:` URL after hard-gate macOS/Ubuntu failed in PR #5.
- Updated branch: Browser-MCP: 03-17-fix_post_merge_bot_followups @ f8cb742
- Hardened artifact persistence against normalized absolute traversal, symlink-parent escapes, and symlink-target writes.
- Switched workspace test artifact directories to a shared helper that leaves no persistent `.tmp-artifacts/` directory behind.
- Updated the living changelog for the router contract change.
- Updated branch: Browser-MCP: 03-17-fix_post_merge_bot_followups @ 71baebf
- PR #5 is green across hard-gate macOS/Ubuntu/Windows after commit 71baebf.
- Replied on remaining open inline review comments for the absolute-path traversal test and prototype-safe replay header accumulator to note they were addressed in 71baebf.
- Replied to open inline review comments via gh api after the MCP GitHub tool returned 403 for review replies.
- Merged PR #5: fix(extension): address post-merge bot followups
- Final repository state: Browser-MCP: trunk @ c971905
