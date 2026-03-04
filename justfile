set shell := ["bash", "-euo", "pipefail", "-c"]

repo := "TWP-Technologies/Browser-MCP"
project := "local-mcp-bun"

default:
  just --list

# Install dependencies and Playwright Chromium.
bootstrap:
  cd {{project}} && bun install
  cd {{project}} && bunx playwright install chromium

# CI-style Linux install (installs OS deps too).
bootstrap-linux:
  cd {{project}} && bun install
  cd {{project}} && bunx playwright install --with-deps chromium

# Run MCP server using real websocket bridge and local loopback defaults.
server:
  cd {{project}} && BRIDGE_MODE=websocket BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=37777 bun run src/index.ts

# Run MCP server with in-memory bridge for quick local checks.
server-in-memory:
  cd {{project}} && BRIDGE_MODE=in_memory bun run src/index.ts

# Run MCP server with auto-generated one-time auth token.
server-auth-auto:
  cd {{project}} && BRIDGE_MODE=websocket BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=37777 MCP_AUTH_TOKEN=auto bun run src/index.ts

lint:
  cd {{project}} && bun run lint:spec
  cd {{project}} && bun run lint:compliance

lint-spec:
  cd {{project}} && bun run lint:spec

lint-compliance:
  cd {{project}} && bun run lint:compliance

test:
  cd {{project}} && bun run test

test-unit:
  cd {{project}} && bun run test:unit

test-integration:
  cd {{project}} && bun run test:integration

test-e2e:
  cd {{project}} && bun run test:e2e

test-fault:
  cd {{project}} && bun run test:fault

test-concurrency:
  cd {{project}} && bun run test:concurrency

test-hard-gate:
  cd {{project}} && bun run test:hard-gate

# Force CDP launch path in E2E to verify strict browser attach behavior.
test-e2e-cdp:
  cd {{project}} && E2E_FORCE_CDP_LAUNCH=1 bun test tests/e2e/extension_roundtrip.test.ts

# Re-enable Windows persistent-context path for E2E validation.
test-e2e-win-persistent:
  cd {{project}} && E2E_WINDOWS_TRY_PERSISTENT_CONTEXT=1 bun test tests/e2e/extension_roundtrip.test.ts

ci-evidence:
  cd {{project}} && HARD_GATE_OUTCOME=success bun run ci:evidence

ci-list branch="trunk" limit="10":
  gh run list --repo {{repo}} --branch {{branch}} --limit {{limit}}

ci-watch run_id:
  gh run watch {{run_id}} --repo {{repo}} --exit-status

ci-view run_id:
  gh run view {{run_id}} --repo {{repo}}

ci-failed-log job_id:
  gh run view --repo {{repo}} --job {{job_id}} --log-failed
