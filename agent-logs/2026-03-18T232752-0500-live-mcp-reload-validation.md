# Live MCP reload validation

- Repository: browser_mcp
- Branch/state: Browser-MCP: trunk @ e16fe93
- Scope: Live validation of the reloaded Browser MCP server/extension using the active MCP connection and a temporary local fixture.

## What I tested

- Confirmed the loaded extension inventory includes `Browser Use for AI Agents` version `0.4.0` and that it is enabled.
- Created and attached to a new public tab at `https://example.com/`.
- Verified successful live tool execution on that tab for:
  - `browser_snapshot`
  - `browser_extract_content`
  - `browser_take_screenshot`
  - `browser_network_requests` (list mode)
  - `browser_performance_metrics`
  - `browser_console_messages`
  - `browser_pdf_save`
  - `browser_list_extensions`
  - `attach_to_tab`
  - `detach_from_tab`
  - `list_available_tabs`
  - `browser_reload_extensions`
- Started a temporary local loopback fixture at `http://127.0.0.1:37891/` and confirmed from the shell that it returned `200 OK`.
- Created and attached to new tabs for that loopback fixture.

## Results

- Core Browser MCP behavior is working live against a normal external page.
- Attach/detach lock behavior is working correctly.
- Screenshot and PDF capture are working.
- Extension reload behaves safely and skips the active extension as expected.
- The loaded Browser MCP extension reports as version `0.4.0`.

## Open issue observed

- Attached `127.0.0.1` tabs consistently behaved like Chrome error pages from Browser MCP's perspective.
- Evidence:
  - `browser_snapshot` first returned an empty snapshot, then consistently returned `ATTACH_FAILED` with `Frame with ID 0 is showing error page`.
  - `browser_extract_content` and `browser_performance_metrics` failed on the same loopback tab with the same `ATTACH_FAILED` error.
  - The shell could still reach the fixture successfully via `curl`, so this is not just the fixture server being down.
- Conclusion:
  - I cannot honestly claim that "everything works now".
  - The core live suite works, but there is still a real local-loopback navigation/inspection issue that matters for a local-first MCP.

## Notes

- `browser_window` with no arguments returned `ATTACH_FAILED: unsupported browser_window action: undefined`. That is not a product failure; it reflects that the current wrapper surface here exposes the forwarded tool without the action arguments that the underlying MCP expects.
- I did not use the downloaded packaged artifact directly in this session; this validation used the currently loaded MCP connection and currently loaded Chrome extension.

## Relevant recent history

```text
e16fe93 docs(agent-logs): capture node24 workflow rerun verification
33290ea ci(actions): move workflows to node24-compatible tooling
ee93c31 Merge pull request #9 from TWP-Technologies/03-18-refactor_mcp_centralize_prompt_catalog_and_bump_to_0.4.0
97b1eeb test(mcp): narrow prompt result typing
111c3d5 Merge pull request #8 from TWP-Technologies/03-18-feat_mcp_add_llm_onboarding_prompts_and_ergonomic_defaults
9832e89 fix(mcp): validate explicit url navigation shape
ac66f1f feat(mcp): add llm onboarding prompts and ergonomic defaults
573c7d0 chore(release): bump version to 0.3.0
b886fcc docs(agent-logs): capture PR #7 fifth review cycle
4cd261b test(integration): tighten ambiguous lookup fixture dispatch
```

## Follow-up changes

- Added a dedicated cross-host fixture helper for manual validation:
  - `local-mcp-bun/scripts/cross_host_fixture.ts`
  - `local-mcp-bun/scripts/manual_validation_fixture.ts`
- Updated `local-mcp-bun/README.md` to distinguish:
  - loopback-only MCP bridge requirements
  - cross-host fixture binding guidance for Windows Chrome + WSL live smoke

## Corrected root cause

- The earlier localhost failure was not a Browser MCP runtime defect.
- It was a validation-topology issue:
  - the temporary page fixture was bound to WSL loopback (`127.0.0.1`)
  - Windows Chrome on this machine could not reach that listener
  - Browser MCP therefore saw Chrome's error page, which it reported accurately
- Rebinding the same fixture to `0.0.0.0` made the page reachable from Windows and Browser MCP then handled the local page successfully.

## Branch state after reviewable diff creation

- Repository: Browser-MCP
- Branch/state: 03-19-feat_scripts_add_cross-host_manual_validation_fixture @ 27ccbcb

## Branch state after bot-driven patch cycle

- Repository: Browser-MCP
- Reviewable branch/state: 03-19-feat_scripts_add_cross-host_manual_validation_fixture @ 729763c
- Log branch/state: 03-19-docs_agent-logs_record_wsl_live_validation_investigation @ 4d2ec90

- Reviewable branch/state: 03-19-feat_scripts_add_cross-host_manual_validation_fixture @ e95831e
- Validation: bun run lint:docs; LOCAL_MCP_TEST_BRIDGE_PORT=37879 bun run test:hard-gate (pass)

- Reviewable branch/state: 03-19-feat_scripts_add_cross-host_manual_validation_fixture @ 1609301
- Validation: LOCAL_MCP_TEST_BRIDGE_PORT=37879 bun run test:hard-gate (pass)

- Reviewable branch/state: 03-19-feat_scripts_add_cross-host_manual_validation_fixture @ ce6212a
- Validation: LOCAL_MCP_TEST_BRIDGE_PORT=37879 bun run test:hard-gate (pass)

- Reviewable branch/state: 03-19-feat_scripts_add_cross-host_manual_validation_fixture @ ff0f30e
- Validation: LOCAL_MCP_TEST_BRIDGE_PORT=37879 bun run test:hard-gate (pass)
