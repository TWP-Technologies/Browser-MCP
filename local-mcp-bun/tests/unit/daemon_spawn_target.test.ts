// Modified by [KnotFalse]
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wait_for_proxy_daemon_state,
  resolve_daemon_spawn_target,
  resolve_proxy_auth_token_for_log,
  resolve_proxy_artifact_root_attachment,
  should_attach_client_artifact_root_to_daemon,
} from "../../src/daemon_controller";

describe("resolve_daemon_spawn_target", () => {
  test("resolves bun source execution to bun + script entry", () => {
    const target = resolve_daemon_spawn_target(
      "/home/user/.bun/bin/bun",
      ["/home/user/.bun/bin/bun", "/repo/local-mcp-bun/src/index.ts"],
      "bun",
    );

    expect(target).toEqual({
      command: "/home/user/.bun/bin/bun",
      args: ["/repo/local-mcp-bun/src/index.ts"],
    });
  });

  test("preserves runtime args for bun source execution", () => {
    const target = resolve_daemon_spawn_target(
      "/home/user/.bun/bin/bun",
      ["/home/user/.bun/bin/bun", "/repo/local-mcp-bun/src/index.ts", "--flag", "value"],
      "bun",
    );

    expect(target).toEqual({
      command: "/home/user/.bun/bin/bun",
      args: ["/repo/local-mcp-bun/src/index.ts", "--flag", "value"],
    });
  });

  test("resolves compiled runtime to executable self command", () => {
    const target = resolve_daemon_spawn_target(
      "/tmp/chrome-browser-mcp-v0.4.0-linux-x64",
      ["bun", "/$bunfs/root/chrome-browser-mcp-v0.4.0-linux-x64"],
      "/tmp/chrome-browser-mcp-v0.4.0-linux-x64",
    );

    expect(target).toEqual({
      command: "/tmp/chrome-browser-mcp-v0.4.0-linux-x64",
      args: [],
    });
  });

  test("passes through runtime args for compiled runtime", () => {
    const target = resolve_daemon_spawn_target(
      "/tmp/chrome-browser-mcp-v0.4.0-linux-x64",
      ["bun", "/$bunfs/root/chrome-browser-mcp-v0.4.0-linux-x64", "--trace"],
      "/tmp/chrome-browser-mcp-v0.4.0-linux-x64",
    );

    expect(target).toEqual({
      command: "/tmp/chrome-browser-mcp-v0.4.0-linux-x64",
      args: ["--trace"],
    });
  });
});

describe("should_attach_client_artifact_root_to_daemon", () => {
  test("attaches client artifact roots automatically for loopback daemon bind hosts", () => {
    expect(should_attach_client_artifact_root_to_daemon({ daemon_host: "127.0.0.1" }, {})).toBe(true);
    expect(should_attach_client_artifact_root_to_daemon({ daemon_host: "localhost" }, {})).toBe(true);
  });

  test("does not attach client artifact roots automatically for non-loopback daemon bind hosts", () => {
    expect(should_attach_client_artifact_root_to_daemon({ daemon_host: "0.0.0.0" }, {})).toBe(false);
  });

  test("supports explicit non-loopback artifact-root attachment opt-in", () => {
    expect(
      should_attach_client_artifact_root_to_daemon(
        { daemon_host: "0.0.0.0" },
        { MCP_ATTACH_CLIENT_ARTIFACT_ROOT: "true" },
      ),
    ).toBe(true);
    expect(
      should_attach_client_artifact_root_to_daemon(
        { daemon_host: "0.0.0.0" },
        { MCP_ATTACH_CLIENT_ARTIFACT_ROOT: "1" },
      ),
    ).toBe(true);
  });

  test("supports explicit loopback artifact-root attachment opt-out", () => {
    expect(
      should_attach_client_artifact_root_to_daemon(
        { daemon_host: "127.0.0.1" },
        { MCP_ATTACH_CLIENT_ARTIFACT_ROOT: "false" },
      ),
    ).toBe(false);
  });
});

describe("resolve_proxy_artifact_root_attachment", () => {
  const daemon_health = {
    started_at: "2026-04-24T00:00:00.000Z",
    pid: 1234,
    daemon_port: 37778,
    bridge_port: 37777,
  };

  const daemon_target = {
    daemon_host: "127.0.0.1",
  };

  const daemon_state = {
    daemon_host: "127.0.0.1",
    started_at: "2026-04-24T00:00:00.000Z",
    pid: 1234,
    daemon_port: 37778,
    bridge_port: 37777,
    artifact_root_token: "artifact-token",
  };

  test("attaches artifact-root token when loopback daemon state provides it", () => {
    expect(resolve_proxy_artifact_root_attachment(daemon_target, daemon_health, {}, daemon_state)).toEqual({
      attach_client_artifact_root: true,
      artifact_root_token: "artifact-token",
      missing_artifact_root_token: false,
    });
  });

  test("reports a missing token when loopback attachment lacks a daemon token", () => {
    expect(resolve_proxy_artifact_root_attachment(daemon_target, daemon_health, {}, undefined)).toEqual({
      attach_client_artifact_root: false,
      missing_artifact_root_token: true,
    });
  });

  test("reports a missing token when daemon state does not match health", () => {
    expect(
      resolve_proxy_artifact_root_attachment(daemon_target, daemon_health, {}, {
        ...daemon_state,
        pid: 4321,
      }),
    ).toEqual({
      attach_client_artifact_root: false,
      missing_artifact_root_token: true,
    });
  });

  test("reports a missing token when daemon state started_at does not match health", () => {
    expect(
      resolve_proxy_artifact_root_attachment(daemon_target, daemon_health, {}, {
        ...daemon_state,
        started_at: "2026-04-24T00:01:00.000Z",
      }),
    ).toEqual({
      attach_client_artifact_root: false,
      missing_artifact_root_token: true,
    });
  });

  test("accepts equivalent loopback aliases when daemon state host differs from the dialed host", () => {
    expect(
      resolve_proxy_artifact_root_attachment(daemon_target, daemon_health, {}, {
        ...daemon_state,
        daemon_host: "localhost",
      }),
    ).toEqual({
      attach_client_artifact_root: true,
      artifact_root_token: "artifact-token",
      missing_artifact_root_token: false,
    });
  });

  test("reports a missing token when daemon state host is not an equivalent loopback host", () => {
    expect(
      resolve_proxy_artifact_root_attachment(daemon_target, daemon_health, {}, {
        ...daemon_state,
        daemon_host: "0.0.0.0",
      }),
    ).toEqual({
      attach_client_artifact_root: false,
      missing_artifact_root_token: true,
    });
  });

  test("does not report a missing token when artifact-root attachment is disabled", () => {
    expect(
      resolve_proxy_artifact_root_attachment(
        daemon_target,
        daemon_health,
        { MCP_ATTACH_CLIENT_ARTIFACT_ROOT: "0" },
        undefined,
      ),
    ).toEqual({
      attach_client_artifact_root: false,
      missing_artifact_root_token: false,
    });
  });
});

describe("resolve_proxy_auth_token_for_log", () => {
  const daemon_health = {
    started_at: "2026-04-24T00:00:00.000Z",
    pid: 1234,
    daemon_port: 37778,
    bridge_port: 37777,
    auth_enabled: false,
  };

  const daemon_target = {
    daemon_host: "127.0.0.1",
  };

  const daemon_state = {
    daemon_host: "127.0.0.1",
    started_at: "2026-04-24T00:00:00.000Z",
    pid: 1234,
    daemon_port: 37778,
    bridge_port: 37777,
    auth_token: "auto-token",
  };

  test("returns auto auth token only when daemon state matches the dialed daemon", () => {
    expect(resolve_proxy_auth_token_for_log(daemon_target, daemon_health, { MCP_AUTH_TOKEN: "auto" }, daemon_state)).toBe(
      "auto-token",
    );
    expect(
      resolve_proxy_auth_token_for_log(daemon_target, daemon_health, { MCP_AUTH_TOKEN: "auto" }, {
        ...daemon_state,
        daemon_port: 47778,
      }),
    ).toBeUndefined();
    expect(
      resolve_proxy_auth_token_for_log(daemon_target, daemon_health, { MCP_AUTH_TOKEN: "auto" }, {
        ...daemon_state,
        started_at: "2026-04-24T00:01:00.000Z",
      }),
    ).toBeUndefined();
  });

  test("does not return an auth token when auto auth was not requested", () => {
    expect(resolve_proxy_auth_token_for_log(daemon_target, daemon_health, {}, daemon_state)).toBeUndefined();
  });
});

describe("wait_for_proxy_daemon_state", () => {
  const daemon_health = {
    started_at: "2026-04-24T00:00:00.000Z",
    pid: 1234,
    daemon_port: 37778,
    bridge_port: 37777,
    auth_enabled: false,
  };

  test("waits for matching daemon state before returning a loopback artifact token", async () => {
    const temp_dir = mkdtempSync(join(tmpdir(), "daemon-state-race-"));
    const state_path = join(temp_dir, "daemon-state.json");
    let timeout_id: ReturnType<typeof setTimeout> | undefined;

    try {
      timeout_id = setTimeout(() => {
        writeFileSync(
          state_path,
          `${JSON.stringify({
            service: "local-mcp-daemon",
            pid: daemon_health.pid,
            started_at: daemon_health.started_at,
            updated_at: daemon_health.started_at,
            daemon_host: "127.0.0.1",
            daemon_port: daemon_health.daemon_port,
            bridge_host: "127.0.0.1",
            bridge_port: daemon_health.bridge_port,
            auth_enabled: false,
            auth_auto: false,
            artifact_root_token: "artifact-token",
          })}\n`,
        );
      }, 20);

      const daemon_state = await wait_for_proxy_daemon_state(
        {
          daemon_host: "127.0.0.1",
          daemon_connect_timeout_ms: 1_000,
          daemon_state_path: state_path,
          env: {},
        },
        daemon_health,
      );

      expect(daemon_state?.artifact_root_token).toBe("artifact-token");
    } finally {
      if (timeout_id) {
        clearTimeout(timeout_id);
      }
      rmSync(temp_dir, { recursive: true, force: true });
    }
  }, 2_000);

  test("waits for matching daemon state when auto-auth is requested by an auth-enabled daemon", async () => {
    const temp_dir = mkdtempSync(join(tmpdir(), "daemon-state-auto-auth-race-"));
    const state_path = join(temp_dir, "daemon-state.json");
    let timeout_id: ReturnType<typeof setTimeout> | undefined;

    try {
      timeout_id = setTimeout(() => {
        writeFileSync(
          state_path,
          `${JSON.stringify({
            service: "local-mcp-daemon",
            pid: daemon_health.pid,
            started_at: daemon_health.started_at,
            updated_at: daemon_health.started_at,
            daemon_host: "127.0.0.1",
            daemon_port: daemon_health.daemon_port,
            bridge_host: "127.0.0.1",
            bridge_port: daemon_health.bridge_port,
            auth_enabled: true,
            auth_auto: true,
            auth_token: "auto-token",
          })}\n`,
        );
      }, 20);

      const daemon_state = await wait_for_proxy_daemon_state(
        {
          daemon_host: "127.0.0.1",
          daemon_connect_timeout_ms: 1_000,
          daemon_state_path: state_path,
          env: {
            MCP_AUTH_TOKEN: "auto",
            MCP_ATTACH_CLIENT_ARTIFACT_ROOT: "0",
          },
        },
        {
          ...daemon_health,
          auth_enabled: true,
        },
      );

      expect(daemon_state?.auth_token).toBe("auto-token");
    } finally {
      if (timeout_id) {
        clearTimeout(timeout_id);
      }
      rmSync(temp_dir, { recursive: true, force: true });
    }
  }, 2_000);

  test("does not wait solely for auto-auth daemon state when the daemon is not auth-enabled", async () => {
    const temp_dir = mkdtempSync(join(tmpdir(), "daemon-state-auto-auth-"));
    const state_path = join(temp_dir, "daemon-state.json");
    let timeout_id: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        wait_for_proxy_daemon_state(
          {
            daemon_host: "127.0.0.1",
            daemon_connect_timeout_ms: 10_000,
            daemon_state_path: state_path,
            env: {
              MCP_AUTH_TOKEN: "auto",
              MCP_ATTACH_CLIENT_ARTIFACT_ROOT: "0",
            },
          },
          daemon_health,
        ).then(() => "returned"),
        new Promise<"waited">((resolve_promise) => {
          timeout_id = setTimeout(() => resolve_promise("waited"), 50);
        }),
      ]);

      expect(result).toBe("returned");
    } finally {
      if (timeout_id) {
        clearTimeout(timeout_id);
      }
      rmSync(temp_dir, { recursive: true, force: true });
    }
  }, 1_000);
});
