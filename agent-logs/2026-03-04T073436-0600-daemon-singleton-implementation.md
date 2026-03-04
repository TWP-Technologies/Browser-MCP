# Session Log

## Scope
- Implement shared singleton daemon model for `local-mcp-bun` so one runtime owns browser bridge bind while multiple MCP stdio clients connect concurrently.
- Preserve lock semantics and tool behavior.
- Add tests, docs, and living-spec updates for daemon ingress + proxy behavior.

## Implemented
- Added reusable MCP protocol session abstraction:
  - `local-mcp-bun/src/mcp_protocol_session.ts`
- Refactored stdio server to use shared protocol session:
  - `local-mcp-bun/src/mcp_stdio_server.ts`
- Added daemon ingress service (`/mcp` websocket + `/health`):
  - `local-mcp-bun/src/daemon_ingress_server.ts`
- Added stdio proxy server for MCP client processes:
  - `local-mcp-bun/src/stdio_proxy_server.ts`
- Added daemon orchestration controller (`auto|proxy|daemon|direct`):
  - `local-mcp-bun/src/daemon_controller.ts`
- Updated startup entrypoint to route through daemon controller:
  - `local-mcp-bun/src/index.ts`
- Added config resolvers for daemon mode/ports/timeouts:
  - `local-mcp-bun/src/config.ts`
- Added unit tests for daemon config behavior:
  - `local-mcp-bun/tests/unit/config.test.ts`
- Added integration test for two concurrent clients sharing one daemon/runtime:
  - `local-mcp-bun/tests/integration/daemon_singleton_proxy.test.ts`
- Updated docs with daemon model, env vars, and examples:
  - `local-mcp-bun/README.md`
- Updated living spec + changelog:
  - `specs/local-multiplexed-browser-mcp-spec.md`
  - `specs/local-multiplexed-browser-mcp-changelog.md`

## Verification
- `bun test tests/unit/config.test.ts tests/integration/mcp_stdio_protocol_compat.test.ts tests/integration/daemon_singleton_proxy.test.ts`
- `bun run test:integration`
- `bun run test:fault`
- `bun run test:unit`
- `bun run test:concurrency`
- `bun run lint:spec`
- `bun run lint:compliance`
- Manual smoke check:
  - started two `bun run src/index.ts` processes with default websocket settings,
  - confirmed second process no longer fails with bridge-port bind error.

## Repo State
- Browser-MCP: `trunk` @ `cc97a5d`

## Recent Commits Reviewed
- `cc97a5d` docs(runtime): document websocket-first defaults and v0.1.1 packaging
- `70b7e4c` chore(release): rename artifact prefix to chrome-browser-mcp
- `94b4be2` chore(package): rename package to @TWP-Technologies/Browser-MCP
- `991b269` chore(version): bump runtime and extension metadata to 0.1.1
- `ed6450c` feat(runtime): default bridge mode to websocket and validate BRIDGE_MODE
