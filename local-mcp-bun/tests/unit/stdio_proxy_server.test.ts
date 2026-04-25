// Modified by [KnotFalse]
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  build_daemon_url_with_client_artifact_root,
  redact_daemon_url_for_logs,
  stdio_proxy_server,
} from "../../src/stdio_proxy_server";

test("daemon proxy URL includes encoded client artifact root", () => {
  const artifact_root = resolve("client workspace");
  const daemon_url = build_daemon_url_with_client_artifact_root(
    "ws://127.0.0.1:37778/mcp",
    artifact_root,
    undefined,
    "artifact-token",
  );
  const parsed_url = new URL(daemon_url);

  expect(parsed_url.pathname).toBe("/mcp");
  expect(parsed_url.searchParams.get("client_artifact_root")).toBe(artifact_root);
  expect(parsed_url.searchParams.get("client_artifact_root_token")).toBe("artifact-token");
  expect(daemon_url).toContain("client_artifact_root=");
});

test("daemon proxy URL preserves existing query params", () => {
  const artifact_root = resolve("client-workspace");
  const daemon_url = build_daemon_url_with_client_artifact_root(
    "ws://127.0.0.1:37778/mcp?existing=1",
    artifact_root,
    undefined,
    "artifact-token",
  );
  const parsed_url = new URL(daemon_url);

  expect(parsed_url.searchParams.get("existing")).toBe("1");
  expect(parsed_url.searchParams.get("client_artifact_root")).toBe(artifact_root);
  expect(parsed_url.searchParams.get("client_artifact_root_token")).toBe("artifact-token");
});

test("daemon proxy URL preserves explicit client artifact root and attaches token", () => {
  const explicit_root = resolve("explicit-workspace");
  const daemon_url = build_daemon_url_with_client_artifact_root(
    `ws://127.0.0.1:37778/mcp?client_artifact_root=${encodeURIComponent(explicit_root)}`,
    resolve("ignored-workspace"),
    undefined,
    "artifact-token",
  );
  const parsed_url = new URL(daemon_url);

  expect(parsed_url.searchParams.get("client_artifact_root")).toBe(explicit_root);
  expect(parsed_url.searchParams.get("client_artifact_root_token")).toBe("artifact-token");
});

test("daemon proxy URL overwrites stale artifact-root tokens when attaching", () => {
  const explicit_root = resolve("explicit-workspace");
  const daemon_url = build_daemon_url_with_client_artifact_root(
    `ws://127.0.0.1:37778/mcp?client_artifact_root=${encodeURIComponent(
      explicit_root,
    )}&client_artifact_root_token=stale-token`,
    resolve("ignored-workspace"),
    true,
    "fresh-token",
  );
  const parsed_url = new URL(daemon_url);

  expect(parsed_url.searchParams.get("client_artifact_root")).toBe(explicit_root);
  expect(parsed_url.searchParams.get("client_artifact_root_token")).toBe("fresh-token");
});

test("daemon proxy URL does not attach client artifact root to remote daemon by default", () => {
  const artifact_root = resolve("client-workspace");
  const daemon_url = build_daemon_url_with_client_artifact_root(
    "ws://example.com:37778/mcp",
    artifact_root,
    undefined,
    "artifact-token",
  );
  const parsed_url = new URL(daemon_url);

  expect(parsed_url.searchParams.get("client_artifact_root")).toBeNull();
  expect(parsed_url.searchParams.get("client_artifact_root_token")).toBeNull();
});

test("daemon proxy URL strips explicit artifact-root params when attachment is disabled", () => {
  const explicit_root = resolve("explicit-workspace");
  const daemon_url = build_daemon_url_with_client_artifact_root(
    `ws://example.com:37778/mcp?client_artifact_root=${encodeURIComponent(
      explicit_root,
    )}&client_artifact_root_token=stale-token&existing=1`,
    resolve("ignored-workspace"),
    false,
    "artifact-token",
  );
  const parsed_url = new URL(daemon_url);

  expect(parsed_url.searchParams.get("existing")).toBe("1");
  expect(parsed_url.searchParams.get("client_artifact_root")).toBeNull();
  expect(parsed_url.searchParams.get("client_artifact_root_token")).toBeNull();
});

test("daemon proxy URL attaches client artifact root to remote daemon when explicitly allowed", () => {
  const artifact_root = resolve("client-workspace");
  const daemon_url = build_daemon_url_with_client_artifact_root(
    "ws://example.com:37778/mcp",
    artifact_root,
    true,
    "artifact-token",
  );
  const parsed_url = new URL(daemon_url);

  expect(parsed_url.searchParams.get("client_artifact_root")).toBe(artifact_root);
  expect(parsed_url.searchParams.get("client_artifact_root_token")).toBe("artifact-token");
});

test("daemon proxy URL normalizes artifact roots before attaching them", () => {
  const daemon_url = build_daemon_url_with_client_artifact_root(
    "ws://127.0.0.1:37778/mcp",
    "relative-workspace",
    undefined,
    "artifact-token",
  );
  const parsed_url = new URL(daemon_url);

  expect(parsed_url.searchParams.get("client_artifact_root")).toBe(resolve("relative-workspace"));
});

test("daemon proxy URL skips artifact-root attachment when cwd is unavailable", () => {
  const original_cwd_descriptor = Object.getOwnPropertyDescriptor(process, "cwd");
  Object.defineProperty(process, "cwd", {
    configurable: true,
    value: () => {
      throw new Error("cwd unavailable");
    },
  });

  try {
    const daemon_url = build_daemon_url_with_client_artifact_root(
      "ws://127.0.0.1:37778/mcp",
      undefined,
      true,
      "artifact-token",
    );
    const parsed_url = new URL(daemon_url);

    expect(parsed_url.searchParams.get("client_artifact_root")).toBeNull();
    expect(parsed_url.searchParams.get("client_artifact_root_token")).toBeNull();
  } finally {
    if (original_cwd_descriptor) {
      Object.defineProperty(process, "cwd", original_cwd_descriptor);
    }
  }
});

test("stdio proxy preserves explicit artifact root when cwd is unavailable", () => {
  const explicit_root = resolve("explicit-workspace");
  const original_cwd_descriptor = Object.getOwnPropertyDescriptor(process, "cwd");
  Object.defineProperty(process, "cwd", {
    configurable: true,
    value: () => {
      throw new Error("cwd unavailable");
    },
  });

  try {
    const proxy = new stdio_proxy_server({
      daemon_url: `ws://127.0.0.1:37778/mcp?client_artifact_root=${encodeURIComponent(explicit_root)}`,
      connect_timeout_ms: 1,
      attach_client_artifact_root: true,
      artifact_root_token: "artifact-token",
    });
    const daemon_url = (proxy as unknown as { daemon_url: string }).daemon_url;
    const parsed_url = new URL(daemon_url);

    expect(parsed_url.searchParams.get("client_artifact_root")).toBe(explicit_root);
    expect(parsed_url.searchParams.get("client_artifact_root_token")).toBe("artifact-token");
  } finally {
    if (original_cwd_descriptor) {
      Object.defineProperty(process, "cwd", original_cwd_descriptor);
    }
  }
});

test("daemon proxy URL redaction removes artifact-root connection metadata", () => {
  const daemon_url = build_daemon_url_with_client_artifact_root(
    "ws://127.0.0.1:37778/mcp",
    resolve("client-workspace"),
    undefined,
    "artifact-token",
  );
  const redacted_url = redact_daemon_url_for_logs(daemon_url);

  expect(redacted_url).toContain("client_artifact_root=%3Credacted%3E");
  expect(redacted_url).toContain("client_artifact_root_token=%3Credacted%3E");
  expect(redacted_url).not.toContain("artifact-token");
  expect(redacted_url).not.toContain(encodeURIComponent(resolve("client-workspace")));
});
