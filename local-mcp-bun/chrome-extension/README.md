# Local MCP Bun Chrome Extension

Modified by [KnotFalse].

This extension opens a local WebSocket connection to `ws://127.0.0.1:37777/extension` and executes debugger actions requested by the Bun MCP server.

## Features

- Reports open tabs to the server.
- Handles `attach_to_tab` and `detach_from_tab` requests via `chrome.debugger`.
- Emits detach notices on `chrome.debugger.onDetach` and tab close.

## Install

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Load unpacked extension from `local-mcp-bun/chrome-extension`.
