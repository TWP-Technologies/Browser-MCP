# Blueprint behavioral parity audit

Date: 2026-03-16
Scope: local browser-tool parity against `blueprint-mcp/server/src/unifiedBackend.js`
Exclusions: remote/cloud relay features, hosted connect flows, and any `browser_connect`-style capability

## Method

- Compared Blueprint tool contracts and behavior in `blueprint-mcp/server/src/unifiedBackend.js`.
- Compared local router contracts in `local-mcp-bun/src/tool_router.ts`.
- Compared local browser execution behavior in `local-mcp-bun/chrome-extension/background.js`.
- Used existing automated evidence where available. Screenshot coverage is runtime-verified; most other rows are static behavioral comparisons.

## Verdict

The local Bun implementation does not have full Blueprint behavioral parity. It has broad tool-name coverage, but most tools are still `partial` because their argument surface, execution semantics, or result shape differ materially from Blueprint.

## Matrix

| Tool | Status | Notes |
| --- | --- | --- |
| `browser_tabs` | `partial` | Local covers `list/new/attach/close`, but ignores Blueprint options such as `stealth` and has lock-oriented attach semantics. |
| `browser_navigate` | `partial` | Action coverage matches broadly, but the local response shape is structured metadata instead of Blueprint’s text/raw-status contract. |
| `browser_interact` | `partial` | Local is missing major Blueprint actions including `mouse_move`, `mouse_click`, `file_upload`, and `force_pseudo_state`. |
| `browser_snapshot` | `partial` | Local returns a flattened DOM slice, not Blueprint’s accessibility-tree snapshot. |
| `browser_lookup` | `partial` | Local text matching is simpler and lacks Blueprint’s richer visibility/coordinate reporting. |
| `browser_get_element_styles` | `partial` | Local returns computed styles only; Blueprint returns matched CSS rules and cascade/source detail. |
| `browser_take_screenshot` | `partial` | Local now supports viewport, full-page, selector, and clip capture, but still lacks Blueprint features like `path`, `highlightClickables`, and `deviceScale`. |
| `browser_evaluate` | `partial` | Local requires `expression`; Blueprint accepts both `expression` and `function`. |
| `browser_console_messages` | `partial` | Local pagination exists, but Blueprint has richer filtering and metadata. |
| `browser_fill_form` | `partial` | Local DOM filling is simpler and does not match Blueprint’s checkbox/radio validation semantics. |
| `browser_drag` | `partial` | Local uses synthetic drag events rather than Blueprint’s more realistic CDP mouse-event sequence. |
| `browser_window` | `partial` | Local uses `chrome.windows`; Blueprint applies stricter validation and different CDP-backed behavior. |
| `browser_verify_text_visible` | `partial` | Local matching is case-insensitive and returns a different shape than Blueprint. |
| `browser_verify_element_visible` | `partial` | Visibility criteria and response shape differ from Blueprint. |
| `browser_network_requests` | `partial` | Local lacks Blueprint’s replay support and richer response-body/filter workflow. |
| `browser_pdf_save` | `partial` | Local always returns base64 and byte count; Blueprint also supports path persistence and richer metadata. |
| `browser_handle_dialog` | `parity` | Local behavior matches the core Blueprint dialog-handle semantics. |
| `browser_list_extensions` | `partial` | Local data shape differs and omits some Blueprint reporting details. |
| `browser_reload_extensions` | `partial` | Local reloads unpacked extensions, but does not report Blueprint-style skipped packed extensions. |
| `browser_performance_metrics` | `partial` | Local exposes legacy `performance.timing` deltas; Blueprint computes much richer Web Vitals-style metrics. |
| `browser_extract_content` | `partial` | Local extracts plain text; Blueprint performs HTML-to-Markdown style extraction with stronger heuristics and metadata. |
| `list_available_tabs` | `intentional_exclusion` | Local-only multiplexing feature; no Blueprint equivalent is expected here. |
| `attach_to_tab` | `intentional_exclusion` | Local-only lock-aware attach surface required for multiplexing. |
| `detach_from_tab` | `intentional_exclusion` | Local-only explicit lock-release surface required for multiplexing. |

## Automated evidence

- Screenshot parity regression coverage:
  - `bun test ./tests/integration/tool_router.test.ts ./tests/integration/mcp_stdio_protocol_compat.test.ts`
  - `bun test ./tests/e2e/extension_screenshot_direct.test.ts --timeout 120000`
- Remaining rows are code-audit validated, not runtime parity-tested.

## Highest-priority gaps

1. `browser_interact`: missing action depth and weaker selector/event semantics.
2. `browser_snapshot`: accessibility-tree parity is absent.
3. `browser_network_requests`: no replay support and reduced filtering/inspection surface.
4. `browser_performance_metrics`: far below Blueprint fidelity.
5. `browser_take_screenshot`: still missing a few Blueprint convenience features despite the core fix.
