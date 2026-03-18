import { describe, expect, test } from "bun:test";
import { resolve_daemon_spawn_target } from "../../src/daemon_controller";

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
