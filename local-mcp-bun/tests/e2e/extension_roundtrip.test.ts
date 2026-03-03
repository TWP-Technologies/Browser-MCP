import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright";
import { websocket_bridge_transport } from "../../src/bridge_transport";
import { tool_error } from "../../src/errors";
import { local_mcp_runtime } from "../../src/runtime";

const current_dir = dirname(fileURLToPath(import.meta.url));
const extension_path = resolve(current_dir, "../../chrome-extension");

let runtime: local_mcp_runtime;
let context: BrowserContext | undefined;
let user_data_dir: string;

async function sleep(timeout_ms: number): Promise<void> {
  await new Promise((resolve_promise) => {
    setTimeout(resolve_promise, timeout_ms);
  });
}

async function wait_for_condition(
  condition: () => boolean | Promise<boolean>,
  timeout_ms = 30_000,
  interval_ms = 100,
): Promise<void> {
  const started_at = Date.now();

  while (Date.now() - started_at < timeout_ms) {
    if (await condition()) {
      return;
    }

    await sleep(interval_ms);
  }

  throw new Error(`timed out after ${timeout_ms}ms waiting for condition`);
}

beforeAll(async () => {
  runtime = new local_mcp_runtime({
    bridge_mode: "websocket",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  user_data_dir = mkdtempSync(join(tmpdir(), "local-mcp-bun-e2e-"));

  context = await chromium.launchPersistentContext(user_data_dir, {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extension_path}`,
      `--load-extension=${extension_path}`,
    ],
  });

  let service_worker = context.serviceWorkers()[0];
  if (!service_worker) {
    service_worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }

  expect(service_worker.url()).toContain("chrome-extension://");

  const page = await context.newPage();
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });

  await wait_for_condition(() => runtime.bridge_transport.get_state() === "up", 30_000, 150);
}, 120_000);

afterAll(async () => {
  try {
    await context?.close();
  } finally {
    await runtime.stop();
    if (user_data_dir) {
      rmSync(user_data_dir, { recursive: true, force: true });
    }
  }
}, 60_000);

test("extension bridge supports attach, navigate, network capture, and pdf export", async () => {
  const { agent_session_id } = runtime.tool_router.open_session("e2e");

  const tabs_result = (await runtime.tool_router.call_tool(agent_session_id, "browser_tabs", {
    action: "list",
  })) as {
    tabs: Array<Record<string, unknown>>;
  };

  const target_tab = tabs_result.tabs.find((tab) => String(tab.url).includes("example.com"));
  expect(target_tab).toBeDefined();

  const target_index = target_tab?.index;
  expect(typeof target_index).toBe("number");

  const attach_result = await runtime.tool_router.call_tool(agent_session_id, "browser_tabs", {
    action: "attach",
    index: target_index,
  });

  expect(attach_result.action).toBe("attach");

  const verify_result = await runtime.tool_router.call_tool(agent_session_id, "browser_verify_text_visible", {
    text: "Example Domain",
  });

  expect(verify_result.visible).toBe(true);

  await runtime.tool_router.call_tool(agent_session_id, "browser_navigate", {
    action: "reload",
  });

  const evaluate_result = await runtime.tool_router.call_tool(agent_session_id, "browser_evaluate", {
    expression: "document.title",
  });

  expect(evaluate_result.ok).toBe(true);
  expect(String(evaluate_result.value)).toContain("Example Domain");

  const extracted = await runtime.tool_router.call_tool(agent_session_id, "browser_extract_content", {
    mode: "auto",
  });

  expect(String(extracted.content)).toContain("Example Domain");

  await sleep(500);
  const network_list = (await runtime.tool_router.call_tool(agent_session_id, "browser_network_requests", {
    action: "list",
    limit: 20,
  })) as {
    requests?: unknown[];
  };

  expect(Array.isArray(network_list.requests)).toBe(true);

  const pdf_result = (await runtime.tool_router.call_tool(agent_session_id, "browser_pdf_save", {
    path: "ignored-by-extension",
  })) as {
    data_base64?: string;
  };

  expect(typeof pdf_result.data_base64).toBe("string");
  expect((pdf_result.data_base64 ?? "").length).toBeGreaterThan(0);

  await runtime.tool_router.close_session(agent_session_id);
}, 120_000);

test("extension bridge recovers after mid-command websocket disconnect", async () => {
  const bridge = runtime.bridge_transport as websocket_bridge_transport;
  const { agent_session_id } = runtime.tool_router.open_session("e2e-restart");

  const tabs_result = (await runtime.tool_router.call_tool(agent_session_id, "browser_tabs", {
    action: "list",
  })) as {
    tabs: Array<Record<string, unknown>>;
  };

  const target_tab = tabs_result.tabs.find((tab) => String(tab.url).includes("example.com"));
  expect(target_tab).toBeDefined();

  await runtime.tool_router.call_tool(agent_session_id, "browser_tabs", {
    action: "attach",
    index: target_tab?.index,
  });

  const in_flight = runtime.tool_router.call_tool(agent_session_id, "browser_interact", {
    actions: [{ type: "wait", timeout: 5000 }],
  });

  await sleep(100);
  bridge.force_extension_disconnect_for_tests(1012, "e2e-restart");

  try {
    await in_flight;
    throw new Error("expected in-flight command to fail after disconnect");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("EXTENSION_UNAVAILABLE");
  }

  await wait_for_condition(() => runtime.bridge_transport.get_state() === "up", 30_000, 150);

  const recovered_snapshot = await runtime.tool_router.call_tool(agent_session_id, "browser_snapshot", {});
  expect(Array.isArray(recovered_snapshot.snapshot)).toBe(true);
  expect((recovered_snapshot.snapshot as unknown[]).length).toBeGreaterThan(0);

  await runtime.tool_router.close_session(agent_session_id);
}, 120_000);
