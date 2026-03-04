# Local MCP Bun Chrome Extension

Modified by [KnotFalse].

This extension opens a local WebSocket connection to `ws://127.0.0.1:37777/extension` and executes debugger actions requested by the Bun MCP server.

## Features

- Reports open tabs to the server.
- Handles `attach_to_tab` and `detach_from_tab` requests via `chrome.debugger`.
- Emits detach notices on `chrome.debugger.onDetach` and tab close.
- Popup controls: enable/disable agent connections, inspect active locks/sessions, update bridge port, and copy full bridge URL.

## Install

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Load unpacked extension from `local-mcp-bun/chrome-extension`.

## Popup UI Build

- Source file: `chrome-extension/popup.ts`
- Built file used by the extension runtime: `chrome-extension/popup.js`
- Build command:
  - `bun run build:popup-ui`
- Type-check command:
  - `bun run check:popup-ui`

If you edit popup UI logic, run the build command before reloading the unpacked extension.

## Connection Behavior

- The extension retries `ws://127.0.0.1:37777/extension` with bounded reconnect backoff when the MCP server is offline.
- Transient startup failures (`ERR_CONNECTION_REFUSED`) are expected when the server is not running yet.
- Reconnect attempts are single-flight and capped to avoid resource churn.

## Troubleshooting

1. Start MCP server with websocket bridge enabled:
   - `BRIDGE_MODE=websocket BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=37777 bun run src/index.ts`
2. Confirm extension `bridge_url` is `ws://127.0.0.1:37777/extension`.
3. Reload the extension once after server starts if reconnect did not occur within a few seconds.
