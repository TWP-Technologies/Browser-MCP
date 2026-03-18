import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tool_error } from "../../src/errors";
import { in_memory_bridge_transport } from "../../src/bridge_transport";
import { local_mcp_runtime } from "../../src/runtime";
import { create_workspace_output_dir } from "../helpers/artifact_output";

function parse_test_bridge_port(): number {
  const parsed_port = Number.parseInt(process.env.LOCAL_MCP_TEST_BRIDGE_PORT ?? "37777", 10);
  return Number.isInteger(parsed_port) && parsed_port > 0 && parsed_port <= 65535 ? parsed_port : 37777;
}

const test_bridge_port = parse_test_bridge_port();

function create_runtime() {
  return new local_mcp_runtime({
    bridge_mode: "in_memory",
    bridge_host: "127.0.0.1",
    bridge_port: test_bridge_port,
  });
}

async function open_attached_session(runtime: local_mcp_runtime, client_name: string) {
  const { agent_session_id } = runtime.tool_router.open_session(client_name);
  await runtime.tool_router.call_tool(agent_session_id, "attach_to_tab", { tab_id: 101 });
  return agent_session_id;
}

test("page-understanding parity tools return structured semantic results", async () => {
  const runtime = create_runtime();
  const session_id = await open_attached_session(runtime, "page-understanding");

  try {
    const snapshot = await runtime.tool_router.call_tool(session_id, "browser_snapshot", {});
    expect(Array.isArray(snapshot.snapshot)).toBe(true);
    expect(snapshot.viewport).toBeDefined();
    const first_interactive = (snapshot.snapshot as Array<Record<string, unknown>>).find(
      (node) => node.interactive === true && typeof node.element_ref === "string",
    );
    expect(first_interactive).toBeDefined();

    const lookup = await runtime.tool_router.call_tool(session_id, "browser_lookup", {
      text: "Primary action",
      limit: 5,
    });
    const first_match = (lookup.matches as Array<Record<string, unknown>>)[0];
    expect(first_match?.element_ref).toBeDefined();
    expect(first_match?.score).toBeDefined();
    expect(first_match?.bounds).toBeDefined();

    const ambiguous_lookup = await runtime.tool_router.call_tool(session_id, "browser_lookup", {
      text: "Ambiguous action",
      limit: 5,
    });
    const ambiguous_match = (ambiguous_lookup.matches as Array<Record<string, unknown>>)[0];
    expect(ambiguous_match?.selector).toBeDefined();
    expect(ambiguous_match?.element_ref).toBeUndefined();

    const styles = await runtime.tool_router.call_tool(session_id, "browser_get_element_styles", {
      element_ref: first_interactive?.element_ref,
      pseudoState: ["hover"],
    });
    expect(styles.matched_rules).toBeDefined();
    expect(styles.computed_style).toBeDefined();

    const evaluate = await runtime.tool_router.call_tool(session_id, "browser_evaluate", {
      function: "() => 'hello from function'",
    });
    expect(evaluate.ok).toBe(true);
    expect(String(evaluate.value)).toContain("in-memory-eval");

    const extracted = await runtime.tool_router.call_tool(session_id, "browser_extract_content", {
      mode: "auto",
      max_lines: 4,
    });
    expect(String(extracted.content)).toContain("# In-memory parity fixture");
    expect(Number(extracted.total_lines)).toBeGreaterThanOrEqual(4);
  } finally {
    await runtime.stop();
  }
});

test("observability parity tools expose filters, replay, and metrics", async () => {
  const runtime = create_runtime();
  const session_id = await open_attached_session(runtime, "observability");

  try {
    const console_messages = await runtime.tool_router.call_tool(session_id, "browser_console_messages", {
      level: "error",
      text: "parity",
    });
    expect(Number(console_messages.total)).toBe(1);
    expect((console_messages.messages as Array<Record<string, unknown>>)[0]?.level).toBe("error");

    const network_list = await runtime.tool_router.call_tool(session_id, "browser_network_requests", {
      action: "list",
      method: "POST",
      resourceType: "fetch",
    });
    const request = (network_list.requests as Array<Record<string, unknown>>)[0];
    expect(request?.request_id).toBe("req-1");

    const network_details = await runtime.tool_router.call_tool(session_id, "browser_network_requests", {
      action: "details",
      requestId: "req-1",
      jsonPath: "$.data.items[0].id",
    });
    const detailed_request = network_details.request as Record<string, unknown> | null;
    expect(detailed_request).not.toBeNull();
    if (!detailed_request) {
      throw new Error("expected browser_network_requests action=details to return request metadata");
    }
    expect(Object.hasOwn(detailed_request, "response_body")).toBe(false);
    expect(Object.hasOwn(detailed_request, "response_body_base64")).toBe(false);
    expect(Object.hasOwn(detailed_request, "response_body_cached_at")).toBe(false);
    expect(network_details.json_path_result).toBe(1);

    const replay = await runtime.tool_router.call_tool(session_id, "browser_network_requests", {
      action: "replay",
      requestId: "req-1",
    });
    expect(replay.replayed).toBe(true);

    const metrics = await runtime.tool_router.call_tool(session_id, "browser_performance_metrics", {});
    const web_vitals = (metrics.metrics as Record<string, unknown>).web_vitals as Record<string, unknown>;
    expect(web_vitals.ttfb).toBeDefined();
    expect(web_vitals.fcp).toBeDefined();
  } finally {
    await runtime.stop();
  }
});

test("browser_take_screenshot persists image artifacts when path is requested", async () => {
  const runtime = create_runtime();
  const session_id = await open_attached_session(runtime, "screenshot-path");
  const output_dir = create_workspace_output_dir("local-mcp-screenshot-");
  const output_path = join(output_dir, "capture.png");

  try {
    const result = await runtime.tool_router.call_tool(session_id, "browser_take_screenshot", {
      type: "png",
      fullPage: true,
      highlightClickables: true,
      deviceScale: 2,
      path: output_path,
    });

    expect(result.saved).toBe(true);
    expect(result.path).toBe(output_path);
    expect(result.data_base64).toBeUndefined();
    expect(result.highlight_clickables).toBe(true);
    expect(result.device_scale).toBe(2);
    expect(readFileSync(output_path).byteLength).toBeGreaterThan(0);
  } finally {
    rmSync(output_dir, { recursive: true, force: true });
    await runtime.stop();
  }
});

test("browser_pdf_save persists artifacts when path is requested", async () => {
  const runtime = create_runtime();
  const session_id = await open_attached_session(runtime, "pdf-path");
  const output_dir = create_workspace_output_dir("local-mcp-pdf-");
  const output_path = join(output_dir, "capture.pdf");

  try {
    const result = await runtime.tool_router.call_tool(session_id, "browser_pdf_save", {
      path: output_path,
    });

    expect(result.saved).toBe(true);
    expect(result.path).toBe(output_path);
    expect(result.mime_type).toBe("application/pdf");
    expect(result.data_base64).toBeUndefined();
    expect(readFileSync(output_path).byteLength).toBeGreaterThan(0);
  } finally {
    rmSync(output_dir, { recursive: true, force: true });
    await runtime.stop();
  }
});

test("artifact persistence rejects paths outside the workspace", async () => {
  const runtime = create_runtime();
  const session_id = await open_attached_session(runtime, "artifact-scope");

  try {
    await runtime.tool_router.call_tool(session_id, "browser_take_screenshot", {
      type: "png",
      path: "../outside-workspace.png",
    });
    throw new Error("expected artifact path validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("INVALID_ARGUMENT");
    expect((error as tool_error).message).toContain("artifact path must stay within the current workspace");
  } finally {
    await runtime.stop();
  }
});

test("artifact persistence rejects absolute paths with traversal segments", async () => {
  const runtime = create_runtime();
  const session_id = await open_attached_session(runtime, "artifact-scope-absolute");
  const escaped_path = `${process.cwd()}${sep}nested${sep}..${sep}..${sep}outside-workspace.png`;

  try {
    await runtime.tool_router.call_tool(session_id, "browser_pdf_save", {
      path: escaped_path,
    });
    throw new Error("expected artifact path normalization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("INVALID_ARGUMENT");
    expect((error as tool_error).message).toContain("artifact path must stay within the current workspace");
  } finally {
    await runtime.stop();
  }
});

test("browser extension management tools return parity metadata", async () => {
  const runtime = create_runtime();
  const session_id = await open_attached_session(runtime, "extensions");

  try {
    const extensions = await runtime.tool_router.call_tool(session_id, "browser_list_extensions", {});
    const listed_extensions = extensions.extensions as Array<Record<string, unknown>>;
    expect(listed_extensions.some((extension) => extension.install_type === "development")).toBe(true);
    expect(listed_extensions.some((extension) => extension.version)).toBe(true);

    const reload_result = await runtime.tool_router.call_tool(session_id, "browser_reload_extensions", {});
    expect(Array.isArray(reload_result.reloaded)).toBe(true);
    expect(Array.isArray(reload_result.skipped)).toBe(true);
  } finally {
    await runtime.stop();
  }
});

test("in-memory bridge request log records the parity test sessions", async () => {
  const runtime = create_runtime();
  const bridge = runtime.bridge_transport as in_memory_bridge_transport;
  bridge.clear_request_log_for_tests();
  const session_id = await open_attached_session(runtime, "request-log-parity");

  try {
    await runtime.tool_router.call_tool(session_id, "browser_performance_metrics", {});
    const request_log = bridge.get_request_log_for_tests();
    expect(request_log.some((entry) => entry.agent_session_id === session_id)).toBe(true);
  } finally {
    await runtime.stop();
  }
});
