# Blueprint behavioral parity audit

Date: 2026-03-17
Scope: local browser-tool parity against `blueprint-mcp/server/src/unifiedBackend.js`
Exclusions: remote/cloud relay features, hosted connect flows, and any `browser_connect`-style capability

## Method

- Compared Blueprint tool contracts and behavior in `blueprint-mcp/server/src/unifiedBackend.js`.
- Compared local router contracts in `local-mcp-bun/src/tool_router.ts`.
- Compared local browser execution behavior in `local-mcp-bun/chrome-extension/background.js`.
- Verified the overlapping tool surface with integration coverage plus targeted browser roundtrip E2E coverage on the local Bun runtime.

## Verdict

The local Bun implementation now reaches behavioral parity for the overlapping Blueprint browser tools in local scope. It intentionally does not copy Blueprint’s text-heavy response shapes; instead it keeps LLM-optimized structured outputs, `element_ref` chaining, and MCP image blocks for screenshots.

## Matrix

| Tool | Status | Notes |
| --- | --- | --- |
| `browser_tabs` | `parity` | Blueprint-equivalent list/new/attach/close behavior plus local lock-aware semantics and real `activate`/`stealth` handling. |
| `browser_navigate` | `parity` | Matching local navigation actions with structured metadata instead of Blueprint prose. |
| `browser_interact` | `parity` | Supports single action and ordered `actions[]`, pointer actions, waits, file upload, pseudo-state forcing, and chained `element_ref` targets. |
| `browser_snapshot` | `parity` | Returns an accessibility-first semantic snapshot with stable `element_ref`s and viewport metadata. |
| `browser_lookup` | `parity` | Returns richer match metadata, scoring, visibility, bounds, and `element_ref` handles. |
| `browser_get_element_styles` | `parity` | Returns computed style plus matched CSS rules/cascade metadata and pseudo-state forcing. |
| `browser_take_screenshot` | `parity` | Supports viewport/full-page/selector/clip capture, `path`, `highlightClickables`, and `deviceScale`; MCP callers still get image blocks when image data is returned. |
| `browser_evaluate` | `parity` | Accepts both `expression` and `function` and returns deterministic structured results. |
| `browser_console_messages` | `parity` | Supports level/text/url filtering plus pagination. |
| `browser_fill_form` | `parity` | Supports selector/`element_ref` targeting and checkbox/radio/select/text semantics. |
| `browser_drag` | `parity` | Uses pointer-event sequencing for source/target dragging. |
| `browser_window` | `parity` | Supports resize/maximize/minimize/close with validation and structured results. |
| `browser_verify_text_visible` | `parity` | Verifies visible text presence in the attached tab with structured output. |
| `browser_verify_element_visible` | `parity` | Verifies selector/`element_ref` visibility with structured output. |
| `browser_network_requests` | `parity` | Supports list/details/replay/clear, filters, response-body inspection, and JSONPath-style lookup. |
| `browser_pdf_save` | `parity` | Supports PDF generation with optional filesystem persistence and structured metadata. |
| `browser_handle_dialog` | `parity` | Matches the core Blueprint dialog-handle semantics. |
| `browser_list_extensions` | `parity` | Reports installed extensions with development-state metadata. |
| `browser_reload_extensions` | `parity` | Reloads unpacked extensions and reports skipped extensions with reasons. |
| `browser_performance_metrics` | `parity` | Returns structured navigation timing, Web Vitals, resource summary, and viewport metrics. |
| `browser_extract_content` | `parity` | Supports `auto`/`full`/`selector` extraction with markdown-oriented output and pagination metadata. |
| `list_available_tabs` | `intentional_addition` | Local-only multiplexing feature; no Blueprint equivalent is expected here. |
| `attach_to_tab` | `intentional_addition` | Local-only lock-aware attach surface required for multiplexing. |
| `detach_from_tab` | `intentional_addition` | Local-only explicit lock-release surface required for multiplexing. |

## Automated evidence

- Integration:
  - `bun test ./tests/integration/tool_router.test.ts ./tests/integration/parity_remaining.test.ts ./tests/integration/mcp_stdio_protocol_compat.test.ts`
- Browser roundtrip E2E:
  - `LOCAL_MCP_TEST_BRIDGE_PORT=37879 bun test ./tests/e2e/extension_roundtrip.test.ts --timeout 120000`

## Notes

- Parity is behavioral, not response-text parity.
- Screenshots remain MCP image-first for callers that do not request `path`; when `path` is requested, the Bun router persists the artifact locally and returns filesystem metadata instead of forcing large base64 payloads back to the model.
- Local multiplexing tools remain additive and intentionally outside the Blueprint comparison surface.
