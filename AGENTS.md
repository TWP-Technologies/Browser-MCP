# Project: Local Multiplexed Browser Use MCP

## 1. Vision & Context

The goal is to fork the `blueprint-mcp` architecture and rebuild it as a local-first, high-performance, and multiplexed browser automation suite. We are intentionally bypassing the subscription-based "Cloud Relay" model by implementing intelligent routing at the local server level.

### Key Objectives:

- **Local-Only:** Zero dependency on proprietary cloud infrastructure or OAuth-based relays.
- **Connection Multiplexing:** Support multiple concurrent AI agent sessions (e.g., Cursor, Claude Desktop, and a custom CLI) communicating with a single browser instance simultaneously.
- **Bun-Native:** Rewrite the Node.js server to use the Bun runtime, leveraging native Zig-backed `Bun.serve()` for WebSocket and HTTP performance.
- **Tab Awareness:** Expose browser tab state to the AI, allowing it to "attach" to existing sessions or spawn new ones based on situational context.

## 2. Technical Architecture: The Multiplexing Router

The system operates as a reverse proxy between multiple MCP clients and a single Chrome Extension connection.

### The Agent Session ID (ASID)

Every incoming MCP client connection must be assigned a unique `agent_session_id`. All messages forwarded to the browser extension must be wrapped in a metadata envelope containing this ID.
Ideally this ID is human-readable or is informative to the LLM/Agent working with the MCP.

### The Debugger Constraint (CRITICAL)

**Assumption Check:** Do not attempt to allow two agents to control the same `tab_id` simultaneously.**Reality:** The `chrome.debugger` API only allows one attachment per tab. If Agent A is attached to Tab 101, Agent B must be blocked from Tab 101 or wait for a detach event. Your routing logic must maintain a `tab_locks` registry to prevent race conditions and "Debugger already attached" errors.

## 3. Implementation Stack & Rules

- **Runtime:** Bun (latest stable).
- **Language:** TypeScript (Native execution).
- **Communication:** WebSockets (via `Bun.serve`) for the Extension; stdio/JSON-RPC for MCP clients.
- **Naming Convention:** Use `snake_case` for all constants, variables, and function names.
- **Comments:** Assume a mid-level engineer audience. No "obvious" comments.

## 4. Work Environment

You must reference and modify the following directories:

1. `blueprint-mcp/server`: Source for the original Node.js MCP server.
2. `blueprint-mcp/extensions/chrome`: Source for the Chrome extension logic.
3. `local-mcp-bun/`: The new Bun-based implementation root.
4. `local-mcp-bun/chrome-extension/`: The modified Chrome extension (co-located, no separate top-level extension directory).

## 5. Required Tool Schema Additions

You are required to implement and expose the following tools to the AI agents (verify if this is already done by the blueprint-mcp or its browser-extension):

- `list_available_tabs`: Returns a list of all open tabs including `tab_id`, `url`, `title`, and `is_locked_by_agent`.
- `attach_to_tab`: Targets a specific `tab_id`. If the tab is already locked, it should return a descriptive error instead of failing silently.
- `detach_from_tab`: Explicitly releases the `chrome.debugger` lock.

## 6. Intellectual Sparring Protocol

Before committing major architectural changes, you must:

1. **Analyze Assumptions:** What are we taking for granted about the WebSocket lifecycle between the browser and the server?
2. **Test Reasoning:** Does the logic hold up if the browser extension restarts or the AI client crashes?
3. **Prioritize Truth:** If the Chrome DevTools Protocol (CDP) imposes a limitation that breaks our multiplexing plan, call it out immediately rather than attempting a fragile workaround.

## 7. Legal/Licensing Compliance

The original code is Apache 2.0.

- Strip all "Rails Blueprint" branding, logos, and trademarks.
- Include the required "Modified by [KnotFalse]" notice
- Ensure the code never attempts to ping `mcp-for-chrome.railsblueprint.com`.

## 8. Living Spec Maintenance

- The canonical specification in `specs/local-multiplexed-browser-mcp-spec.md` is a living document and MUST be updated whenever scoped requirements are completed or materially changed.
- Keep the canonical spec concise. If completion history grows, append detailed change history to a sidecar file (for example `specs/local-multiplexed-browser-mcp-changelog.md`) instead of inflating the canonical spec.
- Pull requests that modify implementation paths under `local-mcp-bun/` SHOULD include corresponding living-spec status updates.
