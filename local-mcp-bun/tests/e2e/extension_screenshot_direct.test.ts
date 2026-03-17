import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type LaunchPersistentContextOptions, type Worker } from "playwright";

const current_dir = dirname(fileURLToPath(import.meta.url));
const extension_path = resolve(current_dir, "../../chrome-extension");
const is_windows = process.platform === "win32";
const force_cdp_launch = process.env.E2E_FORCE_CDP_LAUNCH === "1";
const windows_try_persistent_context = process.env.E2E_WINDOWS_TRY_PERSISTENT_CONTEXT === "1";

let context: BrowserContext | undefined;
let browser: Browser | undefined;
let browser_process: ChildProcess | undefined;
const user_data_dirs: string[] = [];
const fixture_html = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Example Domain</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
      }

      body {
        font-family: sans-serif;
        color: #102033;
        background: #f5f8fc;
      }

      header {
        padding: 24px;
        background: #ffffff;
        border-bottom: 1px solid #d8e1ec;
      }

      main {
        padding: 24px;
      }

      #capture-target {
        width: 320px;
        padding: 24px;
        border: 3px solid #0a5fff;
        border-radius: 16px;
        background: #d9ebff;
        box-shadow: 0 16px 40px rgba(10, 95, 255, 0.18);
      }

      .spacer {
        height: 2200px;
        margin-top: 24px;
        border-radius: 24px;
        background: linear-gradient(180deg, #ffffff 0%, #dbe7f6 100%);
      }

      footer {
        padding: 24px;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Example Domain</h1>
      <p>Test fixture page.</p>
    </header>
    <main>
      <section id="capture-target">
        <h2>Capture Target</h2>
        <p>Selector screenshot target.</p>
      </section>
      <div class="spacer"></div>
      <footer>Bottom of fixture.</footer>
    </main>
  </body>
</html>
`;
const fixture_url = `data:text/html;charset=utf-8,${encodeURIComponent(fixture_html)}`;

interface screenshot_result {
  data_base64?: string;
  mime_type?: string;
  capture_mode?: string;
  full_page?: boolean;
  selector?: string;
}

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
  const user_data_dir = mkdtempSync(join(tmpdir(), "local-mcp-bun-e2e-direct-"));
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
        console.error(`[e2e-direct] failed to cleanup user data dir '${path}':`, error);
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

function parse_png_dimensions(data_base64: string): { width: number; height: number } {
  const bytes = Buffer.from(data_base64, "base64");
  const png_signature = "89504e470d0a1a0a";

  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== png_signature) {
    throw new Error("expected PNG screenshot payload");
  }

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function close_connected_browser(): Promise<void> {
  if (!browser) {
    return;
  }

  try {
    await browser.close();
  } catch (error) {
    console.error("[e2e-direct] failed to close cdp browser connection:", error);
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

async function launch_context_via_cdp(executable_path: string): Promise<BrowserContext | undefined> {
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
    "--disable-gpu",
    "--no-sandbox",
    "--remote-allow-origins=*",
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

  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtools_port}`, {
      timeout: 60_000,
    });
  } catch (error) {
    if (!is_windows) {
      throw error;
    }

    console.error(`[e2e-direct] cdp connection unavailable on windows; skipping direct screenshot assertions: ${stringify_error(error)}`);
    return undefined;
  }

  const connected_context = browser.contexts()[0];
  if (!connected_context) {
    if (is_windows) {
      console.error("[e2e-direct] cdp browser has no attached context on windows; skipping direct screenshot assertions");
      return undefined;
    }

    throw new Error("cdp connection established without a browser context");
  }

  return connected_context;
}

async function launch_extension_context(): Promise<BrowserContext | undefined> {
  const launch_errors: string[] = [];
  const persistent_attempts: Array<{ name: string; launch_options: LaunchPersistentContextOptions }> = [];

  if (!force_cdp_launch) {
    if (is_windows) {
      if (windows_try_persistent_context) {
        persistent_attempts.push({
          name: "playwright-channel-chromium-headless",
          launch_options: { channel: "chromium", headless: true, timeout: 90_000 },
        });
      }
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
      launch_errors.push(`[e2e-direct] launch attempt failed (${attempt.name}): ${stringify_error(error)}`);
    }
  }

  const executable_candidates = is_windows ? get_windows_executable_candidates() : [chromium.executablePath()];

  for (const executable_path of executable_candidates) {
    try {
      return await launch_context_via_cdp(executable_path);
    } catch (error) {
      launch_errors.push(`[e2e-direct] cdp launch attempt failed (${executable_path}): ${stringify_error(error)}`);
      await close_connected_browser();
      await terminate_spawned_browser_process();
    }
  }

  throw new Error(`failed to launch extension test browser context:\n${launch_errors.join("\n")}`);
}

async function resolve_service_worker(): Promise<Worker> {
  if (!context) {
    throw new Error("extension context not initialized");
  }

  let service_worker = context.serviceWorkers()[0];
  if (!service_worker) {
    service_worker = await context.waitForEvent("serviceworker", { timeout: 120_000 });
  }

  return service_worker;
}

async function capture_screenshot(
  service_worker: Worker,
  target_url: string,
  args: Record<string, unknown>,
): Promise<screenshot_result> {
  return (await service_worker.evaluate(
    async ({ current_url, screenshot_args }) => {
      const test_api = globalThis.local_mcp_extension_test_api;
      if (!test_api) {
        throw new Error("local_mcp_extension_test_api is unavailable");
      }

      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((entry) => entry.url === current_url);
      if (!tab?.id) {
        throw new Error(`failed to find tab for url: ${current_url}`);
      }

      await test_api.attach_to_tab(tab.id);
      try {
        return await test_api.execute_browser_take_screenshot(screenshot_args, tab.id);
      } finally {
        try {
          await test_api.detach_from_tab(tab.id);
        } catch {
          // best-effort cleanup inside worker
        }
      }
    },
    {
      current_url: target_url,
      screenshot_args: args,
    },
  )) as screenshot_result;
}

beforeAll(async () => {
  context = await launch_extension_context();
}, 300_000);

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
    await cleanup_user_data_dirs();
  }
}, 180_000);

test("extension service worker captures viewport, full-page, selector, and selector-error screenshots", async () => {
  if (!context) {
    if (!is_windows) {
      throw new Error("extension context not initialized");
    }

    console.error("[e2e-direct] screenshot direct assertions skipped on windows without a CDP browser context");
    return;
  }

  const service_worker = await resolve_service_worker();
  const page = await context.newPage();

  try {
    await page.goto(fixture_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await wait_for_condition(async () => page.url() === fixture_url, 15_000, 100);

    const viewport_result = await capture_screenshot(service_worker, page.url(), {
      type: "png",
    });
    expect(viewport_result.mime_type).toBe("image/png");
    expect(viewport_result.capture_mode).toBe("viewport");
    expect(typeof viewport_result.data_base64).toBe("string");
    const viewport_dimensions = parse_png_dimensions(String(viewport_result.data_base64));

    const full_page_result = await capture_screenshot(service_worker, page.url(), {
      type: "png",
      fullPage: true,
    });
    expect(full_page_result.mime_type).toBe("image/png");
    expect(full_page_result.capture_mode).toBe("full_page");
    expect(full_page_result.full_page).toBe(true);
    expect(typeof full_page_result.data_base64).toBe("string");
    const full_page_dimensions = parse_png_dimensions(String(full_page_result.data_base64));
    expect(full_page_dimensions.height).toBeGreaterThan(viewport_dimensions.height);

    const selector_result = await capture_screenshot(service_worker, page.url(), {
      type: "png",
      selector: "#capture-target",
      padding: 8,
    });
    expect(selector_result.mime_type).toBe("image/png");
    expect(selector_result.capture_mode).toBe("selector");
    expect(selector_result.selector).toBe("#capture-target");
    expect(typeof selector_result.data_base64).toBe("string");
    const selector_dimensions = parse_png_dimensions(String(selector_result.data_base64));
    expect(selector_dimensions.width).toBeLessThan(viewport_dimensions.width);
    expect(selector_dimensions.height).toBeLessThan(viewport_dimensions.height);

    try {
      await capture_screenshot(service_worker, page.url(), {
        type: "png",
        selector: "#missing-target",
      });
      throw new Error("expected missing selector screenshot to fail");
    } catch (error) {
      expect(String(error)).toContain("Element not found");
    }
  } finally {
    await page.close();
  }
}, 120_000);
