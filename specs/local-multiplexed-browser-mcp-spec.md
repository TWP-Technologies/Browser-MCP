# Part 1: The Essentials (Core Requirements for Any Project)

## 1.0 Project Overview (Required)

- **1.1 Project Name:** Local Multiplexed Browser MCP (Bun + Chrome Extension)
- **1.2 Project Goal:** Build a local-only Browser MCP platform that enables multiple AI agents to use one browser concurrently through deterministic session routing and explicit tab-level debugger locking, with no dependency on proprietary cloud relays. The implementation MUST be complete enough for autonomous execution by future agents from specification alone.
- **1.3 Target Audience:** Developers and AI-agent operators running local MCP clients (for example Codex CLI, Cursor, Claude Desktop, custom agents) who need concurrent browser automation on the same workstation.

## 2.0 Core Functionality & User Journeys (Required)

### 2.1 Core Features List

- Multi-client MCP ingress with per-client `agent_session_id` (ASID) assignment and lifecycle tracking.
- Shared singleton daemon ingress for multi-process MCP clients so one runtime owns the bridge bind and multiple stdio clients proxy concurrently.
- Single shared browser-extension bridge over WebSocket using Bun `Bun.serve()`.
- Tab lock orchestration that enforces one debugger owner per `tab_id` at any time.
- Required tools: `list_available_tabs`, `attach_to_tab`, `detach_from_tab`.
- Clean-break v2 API contract for local Bun implementation (no backward-compat guarantee with blueprint tool shapes).
- Structured error model for lock conflicts, stale sessions, extension disconnects, and invalid tool input.
- Debugger-backed screenshot capture that returns MCP image content and supports viewport, full-page, selector, and clipped capture modes.
- Behavioral upstream parity for overlapping local browser tools while preserving LLM-optimized structured outputs, semantic snapshots, optional stable `element_ref` chaining, and optional local artifact persistence.
- The server SHOULD expose first-class onboarding guidance for LLM clients through MCP prompts and a fallback learn/help tool, so clients can discover canonical browser workflows without external documentation.
- `element_ref` reuse is fail-closed: if follow-up resolution cannot prove it still targets the original node, the runtime MUST return `STALE_ELEMENT_REFERENCE` instead of replaying against a first-match selector.
- `browser_snapshot` and `browser_lookup` SHOULD emit `element_ref` only for nodes with a replayably stable unique selector; callers MUST treat `element_ref` as optional.
- `browser_network_requests action=list` MUST remain metadata-only; `action=details` MUST keep the nested `request` payload metadata-only while exposing any decoded response body only through the top-level detail fields. Response bodies SHOULD be fetched lazily by `action=details` and MAY be cached only within bounded in-memory limits.
- The local browser contract SHOULD accept a narrow set of high-confidence LLM ergonomic aliases and defaults without becoming broadly permissive:
  - `browser_navigate` MAY infer `action='url'` when `url` is provided without `action`.
  - `browser_network_requests` SHOULD accept `request_id` as an alias for `requestId`, and the router SHOULD canonicalize it to `requestId` before forwarding the call downstream.
  - `detach_from_tab` MAY infer `tab_id` only when the session owns exactly one tab; otherwise it MUST fail with a corrective `INVALID_ARGUMENT`.
- Crash/restart recovery for client exits and extension restarts.
- Local-only security boundary: loopback binding with optional token authentication and zero cloud relay dependency.
- Co-located repository layout for Bun server and custom extension in a single implementation tree.
- Living specification governance and completion-state updates tied to delivered milestones.

### 2.2 User Journeys

- User starts local MCP server -> app MUST bind to loopback interface and initialize ASID/session registries -> server is ready for concurrent MCP client connections.
- User starts Codex MCP process while daemon already exists -> app MUST proxy stdio traffic to daemon ingress instead of trying to bind `BRIDGE_PORT` again -> second process starts successfully without bridge-port conflict.
- User connects MCP Client A -> app MUST create ASID-A and open a logical routing channel -> Client A receives successful handshake metadata.
- User connects MCP Client B -> app MUST create ASID-B without impacting ASID-A session state -> both clients remain active simultaneously.
- User calls `list_available_tabs` -> app MUST query extension tab inventory and tab lock registry -> response contains `tab_id`, `url`, `title`, `is_locked_by_agent`, and current `locked_by_agent_session_id` when locked.
- User A calls `attach_to_tab(tab_id=101)` when unlocked -> app MUST acquire lock atomically, attach debugger, and set owner ASID-A -> attach succeeds and lock state is visible to all clients.
- User B calls `attach_to_tab(tab_id=101)` while ASID-A owns lock -> app MUST return structured lock-conflict error immediately and MAY accept an optional wait timeout for lock acquisition -> no silent failure and no forced detach of ASID-A.
- User A calls `detach_from_tab(tab_id=101)` -> app MUST detach debugger and release lock atomically -> tab becomes attachable for other clients.
- User extension process restarts -> app MUST mark extension bridge unavailable, fail active debug commands with deterministic retryable errors, and MUST clear/repair stale lock ownership based on detach/disconnect reconciliation logic -> service recovers without manual state surgery.
- User MCP client crashes while holding lock -> app MUST detect channel close, auto-detach when possible, and MUST release lock after timeout guard if detach callback is unavailable -> deadlock is prevented.
- User provides malformed tool arguments -> app MUST return input-validation error with field-level diagnostics -> caller can correct request without inspecting logs.

### 2.3 Feature-to-Test Mapping

- Multi-client ingress + ASID lifecycle -> Unit (ASID generation/registry invariants), Integration (parallel JSON-RPC channels), E2E (8 concurrent clients connect/disconnect churn).
- Shared extension bridge -> Unit (connection state machine), Integration (WebSocket open/message/close/error handlers), E2E (extension reconnect during active sessions).
- Tab lock orchestration -> Unit (atomic lock acquisition/release), Integration (attach conflict path), E2E (two clients race attach to same tab).
- `list_available_tabs` tool -> Unit (response shaping), Contract/API (tool schema validation), Integration (tab inventory + lock merge).
- `attach_to_tab` tool -> Unit (precondition checks), Integration (debugger attach success/failure), E2E (fail-fast conflict and optional wait timeout behavior).
- `detach_from_tab` tool -> Unit (idempotent detach), Integration (detach event handling), E2E (client detach then second client attach).
- `browser_take_screenshot` tool -> Integration (raw image payload + metadata), Contract/API (MCP image content blocks), E2E (viewport/full-page/selector capture and selector failure path).
- Structured error model -> Unit (error code mapping), Contract/API (error payload schema), E2E (observability of error classes under failure injection).
- Crash/restart recovery -> Integration (simulated client crash), E2E (extension restart mid-session), Regression (stale lock cleanup).
- Local security boundary -> Unit (token config parsing), Integration (loopback binding + auth checks), Security (unauthorized local request rejection), E2E (token optional path).
- Living spec governance -> Unit (spec completeness checker script), Integration (CI gate for spec consistency), E2E (milestone completion updates reflected in spec state fields).

## 3.0 Data Models (Required)

- `agent_session`: `agent_session_id` (REQUIRED, string, unique, human-readable prefix + nonce), `client_name` (OPTIONAL, string, max 64 chars), `connected_at` (REQUIRED, RFC3339 timestamp), `last_seen_at` (REQUIRED, RFC3339 timestamp), `state` (REQUIRED, enum: `connected|disconnecting|disconnected`), `auth_mode` (REQUIRED, enum: `none|token`), `owned_tab_ids` (REQUIRED, array<number>, default `[]`).
- `extension_bridge`: `bridge_id` (REQUIRED, string), `connection_state` (REQUIRED, enum: `up|down|reconnecting`), `connected_at` (OPTIONAL, RFC3339 timestamp), `last_disconnect_reason` (OPTIONAL, enum: `socket_closed|heartbeat_timeout|manual|unknown`), `protocol_version` (REQUIRED, semver string).
- `tab_snapshot`: `tab_id` (REQUIRED, integer > 0), `url` (REQUIRED, URL string), `title` (REQUIRED, string), `debugger_attached` (REQUIRED, boolean), `is_locked_by_agent` (REQUIRED, boolean), `locked_by_agent_session_id` (OPTIONAL, string when locked), `lock_acquired_at` (OPTIONAL, RFC3339 timestamp).
- `tab_lock`: `tab_id` (REQUIRED, integer > 0, unique), `owner_agent_session_id` (REQUIRED, string), `lock_state` (REQUIRED, enum: `pending_attach|attached|releasing`), `lease_expires_at` (OPTIONAL, RFC3339 timestamp), `wait_queue` (REQUIRED, array<lock_wait_request>, default `[]`).
- `lock_wait_request`: `agent_session_id` (REQUIRED, string), `requested_at` (REQUIRED, RFC3339 timestamp), `timeout_ms` (REQUIRED, integer, min 1, max 120000), `request_id` (REQUIRED, UUID string).
- `tool_request_envelope`: `request_id` (REQUIRED, UUID string), `agent_session_id` (REQUIRED, string), `tool_name` (REQUIRED, enum), `payload` (REQUIRED, object), `received_at` (REQUIRED, RFC3339 timestamp).
- `tool_error`: `code` (REQUIRED, enum: `LOCK_CONFLICT|LOCK_NOT_OWNED|TAB_NOT_FOUND|INVALID_ARGUMENT|STALE_ELEMENT_REFERENCE|EXTENSION_UNAVAILABLE|TOOL_FAILED|ATTACH_FAILED|DETACH_FAILED|SESSION_NOT_FOUND|UNAUTHORIZED|TIMEOUT`), `message` (REQUIRED, string), `retryable` (REQUIRED, boolean), `details` (OPTIONAL, object), `correlation_id` (REQUIRED, UUID string).
- Element-targeting tools that accept `element_ref` MUST fail with `STALE_ELEMENT_REFERENCE` when the original node cannot be re-identified confidently after navigation or DOM mutation.
- `living_spec_state`: `spec_version` (REQUIRED, semver string), `status` (REQUIRED, enum: `draft|active|superseded`), `last_updated_at` (REQUIRED, RFC3339 timestamp), `completed_requirement_ids` (REQUIRED, array<string>, default `[]`), `completion_notes_file` (OPTIONAL, path string).

## 4.0 Essential Error Handling (Required)

- **No Internet:** The app MUST continue to operate for local browser automation without internet access and MUST display/log a clear "offline-external-services" notice only when optional remote operations are attempted.
- **Invalid User Input:** The app MUST reject malformed tool arguments with deterministic `INVALID_ARGUMENT` responses that identify offending fields and expected types.
- **Server Error:** The app SHOULD return stable generic failure text to clients, MUST include a machine-readable error code, and SHOULD offer retry guidance for retryable failures.
- **Tab Lock Conflict:** The app MUST return `LOCK_CONFLICT` with current owner ASID metadata and MAY include wait options when requested.
- **Extension Bridge Down:** The app MUST return `EXTENSION_UNAVAILABLE`, queue no implicit side effects, and SHOULD trigger reconnect workflow.
- **Client Crash During Lock Ownership:** The app MUST reclaim locks via session close detection and MUST prevent permanent lock leakage.

---

# Part 2: Advanced Specifications (For Complex or High-Fidelity Projects)

## 5.0 Formal Project Controls & Scope (Highly Recommended)

### 5.1 Document Control

- **Version:** 1.0.0
- **Status:** Active (Living Spec)
- **Date:** March 3, 2026

### 5.2 Detailed Scope

- **In Scope**
  - Import upstream `blueprint-mcp` as a pinned Git submodule for reference baseline.
  - Implement `local-mcp-bun/` as Bun + TypeScript clean-break v2 server.
  - Co-locate custom extension under the same implementation repository tree (no separate top-level extension repo requirement).
  - Implement ASID routing, session registry, and message envelopes.
  - Implement tab lock registry and lock conflict handling.
  - Implement required tools: `list_available_tabs`, `attach_to_tab`, `detach_from_tab`.
  - Implement optional token security with loopback-only network binding.
  - Implement crash/restart recovery workflows for clients and extension.
  - Implement observability primitives (structured logs, metrics, trace correlation IDs).
  - Implement hard quality gate test matrix across Linux, macOS, and Windows.
  - Add AGENTS directive that specification artifacts MUST be updated when requirements are completed.

- **Out of Scope**
  - Cloud relay, OAuth broker, or dependence on external vendor transport.
  - Multi-browser support beyond Chromium extension target in v1.
  - Sharing one tab between two active debugger owners simultaneously.
  - Backward compatibility guarantees for old blueprint tool contracts.
  - Hosted SaaS control plane, multi-machine distributed coordination, or remote fleet orchestration.
  - Production-grade RBAC/identity provider integrations.

### 5.3 Glossary of Terms & Acronyms

| Term / Acronym | Definition |
| :--- | :--- |
| ASID | Agent Session ID assigned per MCP client connection. |
| MCP | Model Context Protocol used by AI clients and tools. |
| CDP | Chrome DevTools Protocol used via `chrome.debugger.sendCommand`. |
| Tab Lock | Exclusive ownership record preventing multiple debugger attachments to one tab. |
| Bridge | WebSocket channel between Bun server and custom Chrome extension. |
| Living Spec | Specification that MUST be updated as scope items are completed. |
| FR | Functional Requirement entry in section 6.0. |
| NFR | Non-functional requirement entry in section 7.0. |

### 5.4 Implementation Status Snapshot (Living Spec)

- **Completed in current implementation baseline:** `FR-001`, `FR-002`, `FR-003`, `FR-004`, `FR-005`, `FR-006`, `FR-007`, `FR-008`, `FR-009`, `FR-010`, `FR-011`, `FR-012`, `FR-013`, `FR-014`, `FR-015`, `FR-018`.
- **Partially implemented:** none.
- **Pending:** none for current v1 scope.
- Detailed incremental updates MUST be appended to `specs/local-multiplexed-browser-mcp-changelog.md`.

## 6.0 Granular & Traceable Requirements (Recommended for Traceability)

| ID | Requirement Name / User Story | Description | Priority | Verification / Test Coverage |
| :--- | :--- | :--- | :--- | :--- |
| FR-001 | ASID Assignment | The system MUST create a unique `agent_session_id` for each MCP client connection and persist it for session lifetime. | Critical | Unit (ID format + uniqueness), Integration (parallel connect), E2E (8 clients connect/disconnect). |
| FR-002 | ASID Envelope Routing | The system MUST wrap extension-bound messages with ASID metadata and route replies back to the correct client session. | Critical | Unit (routing table), Integration (cross-session isolation), E2E (interleaved concurrent commands). |
| FR-003 | Shared Extension Bridge | The system MUST maintain one shared extension bridge with explicit up/down/reconnect states. | Critical | Unit (state machine), Integration (socket lifecycle), E2E (forced extension restart recovery). |
| FR-004 | Tab Inventory Merge | The system MUST expose `list_available_tabs` that merges extension tab inventory with lock ownership state. | Critical | Unit (merge logic), Contract/API (schema checks), Integration (real tab list + lock registry). |
| FR-005 | Atomic Lock Acquisition | The system MUST enforce atomic lock acquisition per `tab_id` before debugger attach. | Critical | Unit (atomicity/race tests), Integration (attach race), E2E (simultaneous attach attempts). |
| FR-006 | Attach Tool Behavior | The system MUST implement `attach_to_tab` with fail-fast lock conflict response and optional wait-timeout mode. | Critical | Unit (argument validation), Integration (attach + conflict), E2E (fail-fast + wait timeout scenarios). |
| FR-007 | Detach Tool Behavior | The system MUST implement `detach_from_tab` to release debugger and lock atomically and idempotently. | Critical | Unit (idempotency), Integration (detach event path), E2E (handoff from one client to another). |
| FR-008 | Crash Recovery | The system MUST reclaim locks and reconcile state when a client crashes or disconnects unexpectedly. | High | Unit (session cleanup), Integration (socket close hooks), E2E (kill client while lock held). |
| FR-009 | Extension Restart Recovery | The system MUST reconcile stale attachments/locks when extension disconnects and reconnects, MUST fail in-flight bridge requests deterministically during disconnect, and MUST recover post-reconnect routing without cross-session corruption. | High | Integration (bridge reconnect + in-flight disconnect fault), E2E (restart/disconnect mid-command), Regression (post-reconnect attach/tool call works). |
| FR-010 | Structured Error Contract | The system MUST return structured error payloads with code, retryability, and correlation ID for all tool failures. | High | Unit (error mapping), Contract/API (error schema), E2E (assert consistent error shape). |
| FR-011 | Local Security Boundary | The system MUST bind loopback only and SHOULD support optional token authentication without mandatory manual setup. | High | Unit (config defaults), Integration (localhost only binding), Security (auth optional + rejection cases). |
| FR-012 | AGENTS Governance Update | The implementation MUST update `AGENTS.md` with living-spec maintenance directive and co-located directory policy. | Medium | Unit (lint/check rule for directive presence), Integration (CI policy check), E2E (spec update process in PR workflow). |
| FR-013 | Repository Layout Standard | The implementation MUST use a co-located layout where custom extension resides under the local Bun implementation tree. | High | Unit (path resolver tests), Integration (build/test scripts detect expected layout), E2E (end-to-end dev bootstrap on clean clone). |
| FR-014 | Cross-Platform Test Matrix | The system MUST run required test suites on Linux, macOS, and Windows in CI for release eligibility, and MUST publish per-OS hard-gate evidence artifacts for auditability. | Critical | Integration (CI workflow checks + artifact upload), E2E (matrix run with required pass gates), Performance (runtime bounds per suite). |
| FR-015 | Hard Quality Gate | The release process MUST block merge when unit, integration, e2e, fault-injection, and concurrency suites fail. | Critical | Integration (branch protection + workflow checks), E2E (intentional failing test blocks merge), Regression (gate remains enforced). |
| FR-018 | Legal and Branding Compliance Automation | The system MUST enforce Apache-2.0 modification notice and forbidden branding/endpoint checks via an automated compliance scanner mapped to requirement IDs. | High | Unit (scanner rule fixtures pass/fail), Integration (`lint:compliance` gate), Regression (forbidden token insertion fails CI). |

## 7.0 Measurable Non-Functional Requirements (NFRs) (Critical for Architecture)

| ID | Category | Requirement | Metric / Acceptance Criteria |
| :--- | :--- | :--- | :--- |
| NFR-PERF-001 | Performance | Tool latency under load | p95 latency for `list_available_tabs`, `attach_to_tab`, `detach_from_tab` MUST be < 300ms with 8 concurrent clients and 20 tabs on local host. |
| NFR-ACC-001 | Accuracy | Lock state correctness | Lock ownership reports MUST be 100% consistent with actual debugger attachment state across 10,000 simulated lock operations. |
| NFR-REL-001 | Reliability | Recovery from crashes/restarts | System MUST recover to a consistent lock state within 3 seconds after client crash or extension reconnect in 99% of test runs. |
| NFR-SEC-001 | Security | Local access controls | Server MUST reject non-loopback connections 100% of the time; when token auth is enabled, unauthorized requests MUST be rejected 100% of the time in tests. |
| NFR-SCALE-001 | Scalability | Concurrent agent support | System MUST support at least 8 simultaneous active client sessions with no failed routing or lock corruption during 30-minute soak tests. |
| NFR-EXT-001 | Extensibility | Toolset growth | Adding a new tab-scoped tool MUST require no changes to lock core algorithm and no more than one new adapter module. |
| NFR-OBS-001 | Observability | Debuggability of failures | 100% of failed tool responses MUST include correlation ID and structured error code in logs and client payloads. |

## 8.0 Technical & Architectural Constraints (Optional)

### 8.1 Technology Stack

- Runtime: Bun latest stable.
- Language: TypeScript (strict mode), snake_case naming for constants/variables/functions in this project.
- Server transport: stdio JSON-RPC for MCP clients plus WebSocket bridge to extension via `Bun.serve()`.
- Browser integration: Chrome extension using `chrome.debugger` API and tab APIs.
- Package management: Bun.

### 8.2 Architectural Principles

- Single-writer lock semantics per `tab_id` are mandatory.
- Message routing MUST be deterministic by ASID and request correlation ID.
- Lock state transitions MUST be atomic and observable.
- Extension disconnects MUST never leave unrecoverable lock states.
- No cloud relay or external broker paths are allowed.

### 8.3 Deployment Environment

- Local developer machines on Linux, macOS, Windows.
- Loopback-only server exposure by default.
- Chrome/Chromium extension installed locally.
- CI environment MUST include OS matrix and deterministic test seeds for concurrency suites.

### 8.4 Required Public Tool Interfaces (Clean-Break v2)

- Every advertised MCP tool `inputSchema` MUST be a top-level JSON object schema and MUST NOT use top-level `enum`. Composition keywords (`oneOf`, `anyOf`, `allOf`, `not`) MUST NOT appear anywhere in advertised `inputSchema` trees. Alternative argument shapes MUST be documented in property descriptions and enforced by runtime validation.
- `list_available_tabs(input: {}) -> { tabs: tab_entry[] }`
  - `tab_entry`: `{ tab_id: number, url: string, title: string, is_locked_by_agent: boolean, locked_by_agent_session_id?: string }`
- `attach_to_tab(input: { tab_id: number, wait_timeout_ms?: number }) -> { tab_id: number, attached: boolean, owner_agent_session_id: string }`
  - Lock conflict error payload: `{ code: "LOCK_CONFLICT", retryable: true, details: { tab_id, owner_agent_session_id, requested_wait_timeout_ms? } }`
- `detach_from_tab(input: { tab_id: number }) -> { tab_id: number, detached: boolean }`
  - If caller does not own lock, MUST return `SESSION_NOT_FOUND` or authorization-style ownership error.
- `browser_take_screenshot(input: { type?: "jpeg"|"png", quality?: number, fullPage?: boolean, selector?: string, element_ref?: string, padding?: number, path?: string, highlightClickables?: boolean, deviceScale?: number, clip_x?: number, clip_y?: number, clip_width?: number, clip_height?: number, clip_coordinateSystem?: "viewport"|"page" })`
  - The server MUST return an MCP `content` image block plus structured metadata describing capture mode and image MIME type.
  - Supported capture modes MUST include `viewport`, `full_page`, `selector`, and `clip`.
- `browser_pdf_save(input: { path?: string, landscape?: boolean })`
  - When `path` is provided, the server SHOULD persist the PDF locally and return filesystem metadata instead of returning large inline payloads to MCP callers.

### 8.5 Internal Components

- `session_registry`: manages ASID lifecycle, heartbeat/last_seen, disconnect hooks.
- `bridge_manager`: owns WebSocket lifecycle (`open`, `message`, `close`, `error`, `drain`) and extension heartbeat.
- `tab_lock_manager`: atomic lock/unlock APIs, wait queue, lease expiry, recovery reconciliation.
- `debugger_adapter`: thin wrapper over `chrome.debugger.attach/detach/sendCommand/getTargets`.
- `tool_router`: validates tool input, applies auth, dispatches to domain services, returns structured output/errors.
- `observability_adapter`: structured logs, metrics, correlation IDs.

### 8.6 State Machines

- Lock state machine: `unlocked -> pending_attach -> attached -> releasing -> unlocked`.
- Bridge state machine: `down -> connecting -> up -> reconnecting -> up|down`.
- Session state machine: `connected -> disconnecting -> disconnected`.

### 8.7 Recovery and Consistency Rules

- On `chrome.debugger.onDetach`, lock MUST be released for matching `tab_id` unless reattachment is already pending in same owner session.
- On client disconnect, owned locks MUST enter `releasing` and complete detach within configured timeout.
- On extension bridge loss, active operations MUST fail fast with retryable errors and lock reconciliation MUST run at reconnect.
- Lock reconciliation SHOULD consult debugger target metadata (`getTargets` with `attached` indicator) before final cleanup.

### 8.8 Test Strategy (Hard Gate)

- Unit tests:
  - Lock manager atomicity, lease expiry, wait queue fairness.
  - Session registry lifecycle and crash cleanup.
  - Error mapping and schema serialization.
- Integration tests:
  - MCP stdio multiplexing with concurrent mock clients.
  - WebSocket bridge lifecycle and reconnect behavior.
  - Extension adapter command sequencing.
- E2E tests:
  - Real extension + local server + multi-client harness.
  - Concurrent attach conflict on same tab.
  - Attach/detach handoff across different clients.
- Fault-injection tests:
  - Kill client mid-attach.
  - Drop bridge during command execution.
  - Force detach events (`target_closed`, `canceled_by_user`) and verify cleanup.
- Concurrency/soak tests:
  - 8 concurrent clients for 30 minutes with randomized attach/detach workloads.
  - No lock leaks, no cross-session response corruption, bounded latency.
- CI gates:
  - Linux/macOS/Windows matrix required for merge.
  - Required suites: Unit + Integration + E2E + Fault + Concurrency.
  - Required policy checks: `lint:spec` + `lint:compliance`.
  - CI MUST publish per-OS hard-gate evidence artifacts.

### 8.9 Repository Structure and Migration Plan

- `blueprint-mcp/` (Git submodule, pinned ref, read-only baseline reference).
- `local-mcp-bun/` (authoritative implementation root).
- `local-mcp-bun/chrome-extension/` (co-located custom extension implementation).
- `local-mcp-bun/server/` (Bun MCP server).
- `local-mcp-bun/shared/` (protocol types and schemas).
- Migration sequence MUST be: baseline import -> architecture scaffolding -> lock manager + APIs -> extension bridge integration -> test matrix hardening.

### 8.10 Living Specification Governance

- `AGENTS.md` MUST include directive: specification artifacts are living and MUST be updated when requirements/milestones are completed.
- The primary living spec MUST remain concise; if change history grows, a sidecar completion log file SHOULD be used.
- Pull requests MUST include spec updates whenever FR/NFR status changes.
- CI SHOULD fail if code changes touch scoped implementation paths without corresponding living spec status updates.

## 9.0 Assumptions, Dependencies & Risks (Highly Recommended for Risk Management)

### 9.1 Assumptions

- Chrome extension `chrome.debugger` remains available and permissioned in target Chromium versions.
- One debugger attachment per tab remains an enforced platform constraint.
- Bun WebSocket behavior (`open`, `message`, `close`, `error`, `drain`) is stable across target OSes.
- Local users can install extension and run local MCP server on loopback.
- Clean-break v2 is acceptable and migration burden is managed by project stakeholders.

### 9.2 Dependencies

- Upstream `blueprint-mcp` availability for pinned submodule baseline.
- Bun runtime and TypeScript tooling.
- Chromium extension APIs (`tabs`, `debugger`, runtime messaging).
- CI providers capable of Linux/macOS/Windows matrix execution with browser automation support.
- Test harness tooling for multi-client concurrency and fault injection.

### 9.3 Risks and Mitigations

- **Risk:** Assuming lock cleanup always succeeds on disconnect can leave orphaned state.
  - **Mitigation:** Enforce timeout-based forced cleanup and reconciliation pass on reconnect.
- **Risk:** Optional token auth may be disabled, reducing local process isolation.
  - **Mitigation:** Default to loopback-only, generate optional token automatically, document no-manual-step bootstrap path.
- **Risk:** Cross-platform browser automation flakiness may cause CI instability.
  - **Mitigation:** deterministic retries with cap, test quarantine policy, and platform-specific diagnostics.
- **Risk:** Clean-break API increases migration friction for existing clients.
  - **Mitigation:** publish explicit v2 tool contract docs and migration examples in-repo.
- **Risk:** Submodule drift between baseline and implementation assumptions.
  - **Mitigation:** pin exact commit hash and require explicit update process.
