# Chrome Browser MCP

Local, multiplexed **Model Context Protocol (MCP)** server plus **Chrome extension** for browser automation.  
Run multiple agent clients against one local browser bridge with tab-lock safety and loopback-only defaults.

Modified by [KnotFalse].

## Why This Exists

- Local-first browser automation (no required cloud relay).
- Multiple MCP clients can connect concurrently through a shared daemon.
- One-owner-per-tab locking to avoid `chrome.debugger` contention.
- Release artifacts for Linux, macOS, and Windows.

## Quick Start (Release Artifacts)

1. Download the latest release assets from GitHub Releases:
   - `chrome-browser-mcp-v<version>-<platform>-<arch>[.exe]`
   - `chrome-browser-mcp-chrome-extension-v<version>.zip`
2. On Linux/macOS, make the server executable:

```bash
chmod +x ./chrome-browser-mcp-v<version>-linux-x64
```

3. Start the MCP server (defaults: websocket, `127.0.0.1:37777`):

```bash
./chrome-browser-mcp-v<version>-linux-x64
```

4. Extract the extension zip, then in Chrome open `chrome://extensions`:
   - Enable **Developer mode**
   - Click **Load unpacked**
   - Select the extracted folder (the folder containing `manifest.json`)

5. Verify daemon health:

```bash
curl http://127.0.0.1:37778/health
```

## Add to MCP Clients

Use the absolute path to your downloaded server binary.

### Codex CLI

```bash
codex mcp add chrome-browser-mcp -- /absolute/path/to/chrome-browser-mcp-v<version>-linux-x64
codex mcp list
```

### Claude Code

```bash
claude mcp add chrome-browser-mcp -- /absolute/path/to/chrome-browser-mcp-v<version>-linux-x64
claude mcp list
```

Reference syntax: Anthropic MCP docs (`claude mcp add <name> <command> [args...]`).
https://code.claude.com/docs/en/mcp

### Gemini CLI

```bash
gemini mcp add chrome-browser-mcp /absolute/path/to/chrome-browser-mcp-v<version>-linux-x64
gemini mcp list
```

## Chrome Extension (From Source)

If you cloned this repo instead of using release zip assets, load unpacked from:

- `local-mcp-bun/chrome-extension/`

## Runtime Defaults

- `BRIDGE_MODE=websocket`
- `BRIDGE_HOST=127.0.0.1`
- `BRIDGE_PORT=37777`
- `MCP_DAEMON_MODE=auto`
- `MCP_DAEMON_PORT=37778` (default `BRIDGE_PORT+1`)

## Privacy and Security

This project does **not** send or store your browsing data on remote infrastructure.

However, once connected, your AI agent can access significant browser data through MCP tools, including:

- User activity (for example: network activity, clicks, scroll state, typed input sent through tool actions)
- Website content (for example: text, images, links, page structure, screenshots, PDFs)

We do not control what your agent provider or logging pipeline stores. Agents and tool logs may persist extracted data externally.  
Internet content is inherently untrusted and can contain prompt-injection payloads. Use caution with credentials, secrets, and sensitive pages.

Read the full policy: [Privacy Policy](./PRIVACY.md)

## Developer Docs

Detailed implementation, packaging, and test commands:

- [local-mcp-bun/README.md](./local-mcp-bun/README.md)
- [local-mcp-bun/chrome-extension/README.md](./local-mcp-bun/chrome-extension/README.md)

## License

Apache-2.0 (see upstream attribution and modification notices in-repo).
