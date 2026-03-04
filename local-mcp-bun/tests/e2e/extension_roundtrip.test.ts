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
const windows_try_persistent_context = process.env.E2E_WINDOWS_TRY_PERSISTENT_CONTEXT === "1";
const reconnect_wait_timeout_ms = Number.parseInt(process.env.E2E_RECONNECT_WAIT_TIMEOUT_MS ?? "30000", 10);

let runtime: local_mcp_runtime;
let context: BrowserContext | undefined;
let browser: Browser | undefined;
let browser_process: ChildProcess | undefined;
let fixture_server: Server | undefined;
let fixture_url = "";
let extension_id = "";
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

    const cdp_error = stringify_error(error);
    await wait_for_condition(() => runtime.bridge_transport.get_state() === "up", 90_000, 200);
    console.error(`[e2e] cdp connection unavailable on windows; using process-only bridge mode: ${cdp_error}`);
    return undefined;
  }

  const connected_context = browser.contexts()[0];
  if (!connected_context) {
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

  if (context) {
    let service_worker = context.serviceWorkers()[0];
    if (!service_worker) {
      service_worker = await context.waitForEvent("serviceworker", { timeout: 120_000 });
    }

    expect(service_worker.url()).toContain("chrome-extension://");
    const extension_url_match = /^chrome-extension:\/\/([^/]+)\//.exec(service_worker.url());
    if (!extension_url_match) {
      throw new Error(`failed to resolve extension id from service worker url: ${service_worker.url()}`);
    }
    extension_id = extension_url_match[1];

    const page = await context.newPage();
    await page.goto(fixture_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } else {
    await wait_for_condition(() => runtime.bridge_transport.get_state() === "up", 120_000, 150);

    const { agent_session_id } = runtime.tool_router.open_session("e2e-bootstrap");
    try {
      await runtime.tool_router.call_tool(agent_session_id, "browser_tabs", {
        action: "new",
        url: fixture_url,
      });
    } finally {
      await runtime.tool_router.close_session(agent_session_id);
    }
  }

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

  try {
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
  } finally {
    await runtime.tool_router.close_session(agent_session_id).catch(() => {
      // Best-effort cleanup when the session was already closed by the test path.
    });
  }
}, 120_000);

test("extension bridge recovers after mid-command websocket disconnect", async () => {
  const bridge = runtime.bridge_transport as websocket_bridge_transport;
  const { agent_session_id } = runtime.tool_router.open_session("e2e-restart");

  try {
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

    await wait_for_condition(
      () => runtime.bridge_transport.get_state() === "up",
      Number.isFinite(reconnect_wait_timeout_ms) && reconnect_wait_timeout_ms > 0 ? reconnect_wait_timeout_ms : 30_000,
      150,
    );

    const recovered_snapshot = await runtime.tool_router.call_tool(agent_session_id, "browser_snapshot", {});
    expect(Array.isArray(recovered_snapshot.snapshot)).toBe(true);
    expect((recovered_snapshot.snapshot as unknown[]).length).toBeGreaterThan(0);
  } finally {
    await runtime.tool_router.close_session(agent_session_id).catch(() => {
      // Best-effort cleanup when the session was already closed by the test path.
    });
  }
}, 120_000);

test("extension popup controls connections, sessions, and bridge port", async () => {
  if (!context) {
    throw new Error("browser context is not initialized");
  }

  if (!extension_id) {
    throw new Error("extension id is not initialized");
  }

  const { agent_session_id } = runtime.tool_router.open_session("ui-popup-e2e");
  const bridge = runtime.bridge_transport as websocket_bridge_transport;

  try {
    const tabs_result = (await runtime.tool_router.call_tool(agent_session_id, "browser_tabs", {
      action: "list",
    })) as {
      tabs: Array<Record<string, unknown>>;
    };
    const target_tab = find_fixture_tab(tabs_result.tabs);
    expect(target_tab).toBeDefined();
    const attached_tab_id = Number(target_tab?.tab_id);
    expect(Number.isInteger(attached_tab_id)).toBe(true);
    expect(attached_tab_id > 0).toBe(true);

    await runtime.tool_router.call_tool(agent_session_id, "browser_tabs", {
      action: "attach",
      index: target_tab?.index,
    });

    const popup_page = await context.newPage();
    try {
      await popup_page.goto(`chrome-extension://${extension_id}/popup.html`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const heading_text = await popup_page.locator("h1").textContent();
      expect(heading_text ?? "").toMatch(/(Local MCP Control|Browser Use)/);

      const popup_width = await popup_page.evaluate(() => {
        const app = document.getElementById("app");
        if (!(app instanceof HTMLElement)) {
          throw new Error("popup root is unavailable");
        }

        return Math.round(app.getBoundingClientRect().width);
      });
      expect(popup_width).toBeGreaterThanOrEqual(740);
      expect(popup_width).toBeLessThanOrEqual(768);

      const snapshot_chip = popup_page.locator('[data-testid="snapshot-chip"]');
      expect(await snapshot_chip.isVisible()).toBe(true);
      expect((await snapshot_chip.textContent()) ?? "").toContain("Snapshot");

      await popup_page.evaluate(() => {
        (globalThis as { __popup_test_copied_url__?: string | null }).__popup_test_copied_url__ = null;
        const clipboard_mock = {
          async writeText(value: string): Promise<void> {
            (globalThis as { __popup_test_copied_url__?: string | null }).__popup_test_copied_url__ = value;
          },
        };

        try {
          Object.defineProperty(globalThis.navigator, "clipboard", {
            configurable: true,
            value: clipboard_mock,
          });
        } catch {
          (globalThis.navigator as Navigator & { clipboard?: typeof clipboard_mock }).clipboard = clipboard_mock;
        }
      });

      const copy_bridge_url_button = popup_page.locator('[data-testid="copy-bridge-url-btn"]');
      expect(await copy_bridge_url_button.isVisible()).toBe(true);
      await copy_bridge_url_button.click();

      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const copy_status = document.querySelector('[data-testid="bridge-url-copy-status"]');
            return copy_status instanceof HTMLElement && String(copy_status.textContent || "").includes("Copied");
          }),
        30_000,
        150,
      );

      const copied_bridge_url = await popup_page.evaluate(() => {
        return (globalThis as { __popup_test_copied_url__?: string | null }).__popup_test_copied_url__ ?? null;
      });
      expect(copied_bridge_url).toBe("ws://127.0.0.1:37777/extension");

      const motion_profile = await popup_page.evaluate(() => {
        const toggle_button = document.querySelector('button[data-testid="toggle-enabled-btn"]');
        const poll_indicator = document.getElementById("poll-indicator");

        if (!(toggle_button instanceof HTMLButtonElement)) {
          throw new Error("toggle-enabled button is unavailable");
        }

        if (!(poll_indicator instanceof HTMLElement)) {
          throw new Error("poll indicator is unavailable");
        }

        poll_indicator.classList.remove("poll-indicator--pulse");

        const transition_values = getComputedStyle(toggle_button)
          .transitionDuration.split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .map((entry) => {
            if (entry.endsWith("ms")) {
              return Number.parseFloat(entry) / 1000;
            }

            if (entry.endsWith("s")) {
              return Number.parseFloat(entry);
            }

            return Number.NaN;
          })
          .filter((entry) => Number.isFinite(entry));

        const max_toggle_transition_seconds = transition_values.length > 0 ? Math.max(...transition_values) : 0;
        const base_animation_name = getComputedStyle(poll_indicator).animationName;

        poll_indicator.classList.add("poll-indicator--pulse");
        const pulse_duration_raw = getComputedStyle(poll_indicator).animationDuration.split(",")[0]?.trim() ?? "0s";
        poll_indicator.classList.remove("poll-indicator--pulse");

        const pulse_animation_seconds = pulse_duration_raw.endsWith("ms")
          ? Number.parseFloat(pulse_duration_raw) / 1000
          : pulse_duration_raw.endsWith("s")
            ? Number.parseFloat(pulse_duration_raw)
            : Number.NaN;

        return {
          max_toggle_transition_seconds,
          base_animation_name,
          pulse_animation_seconds,
        };
      });

      expect(motion_profile.max_toggle_transition_seconds).toBeGreaterThanOrEqual(0.22);
      expect(motion_profile.max_toggle_transition_seconds).toBeLessThanOrEqual(0.45);
      expect(motion_profile.base_animation_name).toBe("none");
      expect(motion_profile.pulse_animation_seconds).toBeGreaterThanOrEqual(0.85);
      expect(motion_profile.pulse_animation_seconds).toBeLessThanOrEqual(1.2);

      const ui_stability = await popup_page.evaluate(async () => {
        const initial = document.querySelector('button[data-testid="toggle-enabled-btn"]');
        if (!(initial instanceof HTMLButtonElement)) {
          throw new Error("toggle-enabled button is unavailable");
        }

        let last = initial;
        let replacement_count = 0;

        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const current = document.querySelector('button[data-testid="toggle-enabled-btn"]');
          if (!(current instanceof HTMLButtonElement)) {
            throw new Error("toggle-enabled button disappeared");
          }

          if (current !== last) {
            replacement_count += 1;
            last = current;
          }
        }

        return {
          replacement_count,
        };
      });
      expect(ui_stability.replacement_count).toBeLessThanOrEqual(6);

      const detach_button = popup_page.locator(`button[data-action=\"detach-tab\"][data-tab-id=\"${attached_tab_id}\"]`);
      expect(await detach_button.isVisible()).toBe(true);
      await detach_button.click();
      await wait_for_condition(() => typeof runtime.tab_lock_manager.get_lock(attached_tab_id) === "undefined", 30_000, 150);

      await runtime.tool_router.call_tool(agent_session_id, "attach_to_tab", { tab_id: attached_tab_id });
      await wait_for_condition(
        () => runtime.tab_lock_manager.get_lock(attached_tab_id)?.owner_agent_session_id === agent_session_id,
        30_000,
        150,
      );

      const close_session_button = popup_page.locator(
        `button[data-action=\"close-session\"][data-agent-session-id=\"${agent_session_id}\"]`,
      );
      expect(await close_session_button.isVisible()).toBe(true);

      await popup_page.evaluate(async (session_id) => {
        const response = await chrome.runtime.sendMessage({
          type: "ui_close_session",
          agent_session_id: session_id,
        });
        if (!response || response.ok !== true) {
          throw new Error(`ui_close_session failed: ${response?.error || "unknown error"}`);
        }
      }, agent_session_id);
      await wait_for_condition(() => !runtime.session_registry.list_active_sessions().includes(agent_session_id), 30_000, 150);

      const disable_flow_session_id = runtime.tool_router.open_session("ui-popup-disable-flow").agent_session_id;
      await runtime.tool_router.call_tool(disable_flow_session_id, "attach_to_tab", { tab_id: attached_tab_id });
      await wait_for_condition(
        () =>
          popup_page.evaluate((session_id) => {
            const button = document.querySelector(
              `button[data-action="close-session"][data-agent-session-id="${session_id}"]`,
            );
            return button instanceof HTMLButtonElement;
          }, disable_flow_session_id),
        30_000,
        150,
      );

      const toggle_button = popup_page.locator('button[data-testid="toggle-enabled-btn"]');
      await toggle_button.click();
      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const cancel_button = document.querySelector('button[data-action="disable-modal-cancel"]');
            return cancel_button instanceof HTMLButtonElement;
          }),
        30_000,
        150,
      );

      await popup_page.evaluate(() => {
        const cancel_button = document.querySelector('button[data-action="disable-modal-cancel"]');
        if (!(cancel_button instanceof HTMLButtonElement)) {
          throw new Error("disable cancel button is unavailable");
        }

        cancel_button.click();
      });
      await wait_for_condition(() => bridge.get_state() === "up", 30_000, 150);

      await popup_page.evaluate(() => {
        const toggle = document.querySelector('button[data-testid="toggle-enabled-btn"]');
        if (!(toggle instanceof HTMLButtonElement)) {
          throw new Error("toggle-enabled button is unavailable");
        }

        toggle.click();
      });
      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const action_button = document.querySelector('button[data-action="disable-modal-close-all"]');
            return action_button instanceof HTMLButtonElement;
          }),
        30_000,
        150,
      );

      await popup_page.evaluate(() => {
        const action_button = document.querySelector('button[data-action="disable-modal-close-all"]');
        if (!(action_button instanceof HTMLButtonElement)) {
          throw new Error("disable close-all button is unavailable");
        }

        action_button.click();
      });
      await wait_for_condition(() => runtime.session_registry.list_active_sessions().length === 0, 45_000, 150);
      await wait_for_condition(() => bridge.get_state() !== "up", 45_000, 150);
      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const toggle = document.querySelector('button[data-testid="toggle-enabled-btn"]');
            return toggle instanceof HTMLButtonElement && String(toggle.textContent || "").includes("Enable");
          }),
        30_000,
        150,
      );

      await popup_page.evaluate(() => {
        const toggle = document.querySelector('button[data-testid="toggle-enabled-btn"]');
        if (!(toggle instanceof HTMLButtonElement)) {
          throw new Error("toggle-enabled button is unavailable");
        }

        toggle.click();
      });
      await wait_for_condition(() => bridge.get_state() === "up", 45_000, 150);

      expect(
        await popup_page.evaluate(() => {
          const port_input = document.getElementById("port-input");
          return port_input instanceof HTMLInputElement;
        }),
      ).toBe(true);

      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const port_input = document.getElementById("port-input");
            const save_button = document.querySelector('button[data-action="save-port"]');
            return (
              port_input instanceof HTMLInputElement &&
              save_button instanceof HTMLButtonElement &&
              !port_input.disabled &&
              !save_button.disabled
            );
          }),
        30_000,
        150,
      );

      await popup_page.evaluate((next_port) => {
        const port_input = document.getElementById("port-input");
        const save_button = document.querySelector('button[data-action="save-port"]');
        if (!(port_input instanceof HTMLInputElement) || !(save_button instanceof HTMLButtonElement)) {
          throw new Error("port controls are unavailable");
        }

        port_input.value = String(next_port);
        port_input.dispatchEvent(new Event("input", { bubbles: true }));
        save_button.click();
      }, 37778);
      await wait_for_condition(
        async () =>
          bridge.get_state() !== "up" ||
          (await popup_page.evaluate(() => {
            const chips = Array.from(document.querySelectorAll(".chip"));
            return chips.some((chip) => String(chip.textContent || "").includes("Waiting for connection"));
          })),
        30_000,
        150,
      );
      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const chips = Array.from(document.querySelectorAll(".chip"));
            return chips.some((chip) => String(chip.textContent || "").includes("Waiting for connection"));
          }),
        30_000,
        150,
      );
      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const poll_status_label = document.getElementById("poll-status-label");
            if (!(poll_status_label instanceof HTMLElement)) {
              return false;
            }

            const text = String(poll_status_label.textContent || "");
            return /^Polling in \d+s$/.test(text) || text === "Polling now...";
          }),
        30_000,
        150,
      );

      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const port_input = document.getElementById("port-input");
            const save_button = document.querySelector('button[data-action="save-port"]');
            return (
              port_input instanceof HTMLInputElement &&
              save_button instanceof HTMLButtonElement &&
              !port_input.disabled &&
              !save_button.disabled
            );
          }),
        30_000,
        150,
      );

      await popup_page.evaluate((next_port) => {
        const port_input = document.getElementById("port-input");
        const save_button = document.querySelector('button[data-action="save-port"]');
        if (!(port_input instanceof HTMLInputElement) || !(save_button instanceof HTMLButtonElement)) {
          throw new Error("port controls are unavailable");
        }

        port_input.value = String(next_port);
        port_input.dispatchEvent(new Event("input", { bubbles: true }));
        save_button.click();
      }, 37777);
      await wait_for_condition(() => bridge.get_state() === "up", 45_000, 150);

      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const toggle_button = document.querySelector('button[data-testid="toggle-enabled-btn"]');
            return toggle_button instanceof HTMLButtonElement && !toggle_button.disabled;
          }),
        30_000,
        150,
      );

      let expected_bridge_up = false;
      for (let index = 0; index < 6; index += 1) {
        await popup_page.evaluate(() => {
          const toggle_button = document.querySelector('button[data-testid="toggle-enabled-btn"]');
          if (!(toggle_button instanceof HTMLButtonElement)) {
            throw new Error("toggle-enabled button is unavailable");
          }

          toggle_button.click();
        });

        await wait_for_condition(() => (bridge.get_state() === "up") === expected_bridge_up, expected_bridge_up ? 45_000 : 30_000, 150);

        await wait_for_condition(
          () =>
            popup_page.evaluate(() => {
              const toggle_button = document.querySelector('button[data-testid="toggle-enabled-btn"]');
              return toggle_button instanceof HTMLButtonElement && !toggle_button.disabled;
            }),
          30_000,
          150,
        );

        expected_bridge_up = !expected_bridge_up;
      }

      await popup_page.evaluate(() => {
        const toggle_button = document.querySelector('button[data-testid="toggle-enabled-btn"]');
        if (!(toggle_button instanceof HTMLButtonElement)) {
          throw new Error("toggle-enabled button is unavailable");
        }

        toggle_button.click();
        toggle_button.click();
      });
      await wait_for_condition(
        () =>
          popup_page.evaluate(() => {
            const toggle_button = document.querySelector('button[data-testid="toggle-enabled-btn"]');
            return toggle_button instanceof HTMLButtonElement && !toggle_button.disabled;
          }),
        30_000,
        150,
      );
      await wait_for_condition(() => bridge.get_state() === "up", 45_000, 150);
    } finally {
      await popup_page.close();
    }
  } finally {
    await runtime.tool_router.close_session(agent_session_id).catch(() => {
      // Best-effort cleanup when the session was already closed by the test path.
    });
  }
}, 180_000);
