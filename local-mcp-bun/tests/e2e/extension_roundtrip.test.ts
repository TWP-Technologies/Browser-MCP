import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type LaunchPersistentContextOptions } from "playwright";
import { websocket_bridge_transport } from "../../src/bridge_transport";
import { tool_error } from "../../src/errors";
import { local_mcp_runtime } from "../../src/runtime";

const current_dir = dirname(fileURLToPath(import.meta.url));
const extension_path = resolve(current_dir, "../../chrome-extension");
const is_windows = process.platform === "win32";
const force_cdp_launch = process.env.E2E_FORCE_CDP_LAUNCH === "1";

let runtime: local_mcp_runtime;
let context: BrowserContext | undefined;
let browser: Browser | undefined;
let browser_process: ChildProcess | undefined;
let fixture_server: Server | undefined;
let fixture_url = "";
const user_data_dirs: string[] = [];

async function sleep(timeout_ms: number): Promise<void> {
  await new Promise((resolve_promise) => {
    setTimeout(resolve_promise, timeout_ms);
  });
}

function stringify_error(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function create_user_data_dir(): string {
  const user_data_dir = mkdtempSync(join(tmpdir(), "local-mcp-bun-e2e-"));
  user_data_dirs.push(user_data_dir);
  return user_data_dir;
}

async function cleanup_user_data_dir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 11) {
        console.error(`[e2e] failed to cleanup user data dir '${path}':`, error);
        return;
      }

      await sleep(250 * (attempt + 1));
    }
  }
}

async function cleanup_user_data_dirs(): Promise<void> {
  for (const user_data_dir of user_data_dirs) {
    await cleanup_user_data_dir(user_data_dir);
  }
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

function find_fixture_tab(tabs: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return tabs.find((tab) => String(tab.url).startsWith(fixture_url));
}

async function close_connected_browser(): Promise<void> {
  if (!browser) {
    return;
  }

  try {
    await browser.close();
  } catch (error) {
    console.error("[e2e] failed to close cdp browser connection:", error);
  } finally {
    browser = undefined;
  }
}

async function terminate_spawned_browser_process(): Promise<void> {
  if (!browser_process) {
    return;
  }

  const process_pid = browser_process.pid;

  if (browser_process.exitCode === null) {
    browser_process.kill();
    await sleep(1000);
  }

  if (browser_process.exitCode === null && is_windows && typeof process_pid === "number") {
    spawnSync("taskkill", ["/PID", String(process_pid), "/T", "/F"], { stdio: "ignore" });
  }

  browser_process = undefined;
}

async function launch_persistent_context(
  user_data_dir: string,
  launch_options: LaunchPersistentContextOptions,
): Promise<BrowserContext> {
  const args = [
    `--disable-extensions-except=${extension_path}`,
    `--load-extension=${extension_path}`,
    ...(launch_options.args ?? []),
  ];

  return await chromium.launchPersistentContext(user_data_dir, {
    ...launch_options,
    ignoreDefaultArgs: ["--disable-extensions"],
    args,
  });
}

function get_windows_executable_candidates(): string[] {
  const raw_candidates = [
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];

  const seen = new Set<string>();
  const existing_candidates: string[] = [];

  for (const candidate of raw_candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      continue;
    }

    if (!existsSync(candidate) || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    existing_candidates.push(candidate);
  }

  return existing_candidates;
}

async function launch_context_via_cdp(executable_path: string): Promise<BrowserContext> {
  const user_data_dir = create_user_data_dir();
  const devtools_port_file = join(user_data_dir, "DevToolsActivePort");

  const launch_args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${user_data_dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-popup-blocking",
    "--disable-renderer-backgrounding",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--headless=new",
    `--disable-extensions-except=${extension_path}`,
    `--load-extension=${extension_path}`,
    "about:blank",
  ];

  browser_process = spawn(executable_path, launch_args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  let stderr_output = "";
  browser_process.stderr?.on("data", (chunk) => {
    if (stderr_output.length >= 8_000) {
      return;
    }

    stderr_output += String(chunk);
  });

  await wait_for_condition(
    () => existsSync(devtools_port_file) || browser_process?.exitCode !== null,
    45_000,
    200,
  );

  if (!existsSync(devtools_port_file)) {
    throw new Error(
      `DevToolsActivePort was not created (exit_code=${browser_process.exitCode ?? "running"} stderr=${stderr_output.slice(0, 500)})`,
    );
  }

  const devtools_lines = readFileSync(devtools_port_file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const devtools_port = Number(devtools_lines[0]);
  if (!Number.isFinite(devtools_port) || devtools_port <= 0) {
    throw new Error(`invalid DevTools port file contents: ${JSON.stringify(devtools_lines)}`);
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtools_port}`, {
    timeout: 30_000,
  });

  const connected_context = browser.contexts()[0];
  if (!connected_context) {
    throw new Error("cdp connection established without a browser context");
  }

  return connected_context;
}

async function launch_extension_context(): Promise<BrowserContext> {
  const launch_errors: string[] = [];

  const persistent_attempts: Array<{ name: string; launch_options: LaunchPersistentContextOptions }> = [];

  if (!force_cdp_launch) {
    if (is_windows) {
      persistent_attempts.push(
        {
          name: "playwright-channel-chromium-headless",
          launch_options: { channel: "chromium", headless: true, timeout: 60_000 },
        },
        {
          name: "playwright-channel-chrome-headless",
          launch_options: { channel: "chrome", headless: true, timeout: 60_000 },
        },
        {
          name: "playwright-channel-msedge-headless",
          launch_options: { channel: "msedge", headless: true, timeout: 60_000 },
        },
        {
          name: "playwright-default-headless",
          launch_options: { headless: true, timeout: 60_000 },
        },
      );
    } else {
      persistent_attempts.push({
        name: "playwright-channel-chromium-headless",
        launch_options: { channel: "chromium", headless: true, timeout: 180_000 },
      });
    }
  }

  for (const attempt of persistent_attempts) {
    const user_data_dir = create_user_data_dir();

    try {
      return await launch_persistent_context(user_data_dir, attempt.launch_options);
    } catch (error) {
      const message = `[e2e] launch attempt failed (${attempt.name}): ${stringify_error(error)}`;
      console.error(message);
      launch_errors.push(message);
    }
  }

  const executable_candidates = is_windows ? get_windows_executable_candidates() : [chromium.executablePath()];

  for (const executable_path of executable_candidates) {
    try {
      return await launch_context_via_cdp(executable_path);
    } catch (error) {
      const message = `[e2e] cdp launch attempt failed (${executable_path}): ${stringify_error(error)}`;
      console.error(message);
      launch_errors.push(message);
      await close_connected_browser();
      await terminate_spawned_browser_process();
    }
  }

  throw new Error(`failed to launch extension test browser context:\n${launch_errors.join("\n")}`);
}

beforeAll(async () => {
  fixture_server = Bun.serve({
    port: 0,
    fetch(): Response {
      return new Response(
        "<!doctype html><html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>Test fixture page.</p></body></html>",
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    },
  });
  fixture_url = `http://127.0.0.1:${fixture_server.port}/`;

  runtime = new local_mcp_runtime({
    bridge_mode: "websocket",
    bridge_host: "127.0.0.1",
    bridge_port: 37777,
  });

  context = await launch_extension_context();

  let service_worker = context.serviceWorkers()[0];
  if (!service_worker) {
    service_worker = await context.waitForEvent("serviceworker", { timeout: 120_000 });
  }

  expect(service_worker.url()).toContain("chrome-extension://");

  const page = await context.newPage();
  await page.goto(fixture_url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  await wait_for_condition(() => runtime.bridge_transport.get_state() === "up", 90_000, 150);
}, 600_000);

afterAll(async () => {
  try {
    if (browser) {
      await close_connected_browser();
    } else {
      await context?.close();
    }
  } finally {
    context = undefined;
    await terminate_spawned_browser_process();
    await runtime.stop();
    fixture_server?.stop(true);
    await cleanup_user_data_dirs();
  }
}, 180_000);

test("extension bridge supports attach, navigate, network capture, and pdf export", async () => {
  const { agent_session_id } = runtime.tool_router.open_session("e2e");

  const tabs_result = (await runtime.tool_router.call_tool(agent_session_id, "browser_tabs", {
    action: "list",
  })) as {
    tabs: Array<Record<string, unknown>>;
  };

  const target_tab = find_fixture_tab(tabs_result.tabs);
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

  const target_tab = find_fixture_tab(tabs_result.tabs);
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
