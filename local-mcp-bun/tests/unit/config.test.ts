import { expect, test } from "bun:test";
import {
  assert_loopback_host,
  is_loopback_host,
  resolve_auth_token,
  resolve_bridge_mode,
  resolve_daemon_connect_timeout_ms,
  resolve_daemon_idle_timeout_ms,
  resolve_daemon_mode,
  resolve_daemon_port,
} from "../../src/config";

test("is_loopback_host accepts loopback hostnames and addresses", () => {
  expect(is_loopback_host("localhost")).toBe(true);
  expect(is_loopback_host("127.0.0.1")).toBe(true);
  expect(is_loopback_host("127.12.34.56")).toBe(true);
  expect(is_loopback_host("::1")).toBe(true);
  expect(is_loopback_host("[::1]")).toBe(true);
});

test("is_loopback_host rejects non-loopback hosts", () => {
  expect(is_loopback_host("0.0.0.0")).toBe(false);
  expect(is_loopback_host("192.168.1.5")).toBe(false);
  expect(is_loopback_host("10.0.0.1")).toBe(false);
  expect(is_loopback_host("example.com")).toBe(false);
});

test("assert_loopback_host throws for non-loopback hosts", () => {
  expect(() => assert_loopback_host("0.0.0.0")).toThrow();
  expect(() => assert_loopback_host("192.168.1.5")).toThrow();
});

test("resolve_auth_token returns configured token when provided", () => {
  const result = resolve_auth_token({
    MCP_AUTH_TOKEN: "secret",
  });

  expect(result.auth_token).toBe("secret");
  expect(result.generated_automatically).toBe(false);
});

test("resolve_auth_token can auto-generate token without manual value", () => {
  const auto_by_keyword = resolve_auth_token({
    MCP_AUTH_TOKEN: "auto",
  });
  expect(auto_by_keyword.generated_automatically).toBe(true);
  expect(typeof auto_by_keyword.auth_token).toBe("string");
  expect((auto_by_keyword.auth_token ?? "").startsWith("auto-")).toBe(true);

  const auto_by_flag = resolve_auth_token({
    MCP_AUTH_AUTO: "1",
  });
  expect(auto_by_flag.generated_automatically).toBe(true);
  expect(typeof auto_by_flag.auth_token).toBe("string");
  expect((auto_by_flag.auth_token ?? "").startsWith("auto-")).toBe(true);
});

test("resolve_bridge_mode defaults to websocket when unset", () => {
  expect(resolve_bridge_mode({})).toBe("websocket");
  expect(resolve_bridge_mode({ BRIDGE_MODE: "" })).toBe("websocket");
});

test("resolve_bridge_mode accepts supported explicit values", () => {
  expect(resolve_bridge_mode({ BRIDGE_MODE: "websocket" })).toBe("websocket");
  expect(resolve_bridge_mode({ BRIDGE_MODE: "in_memory" })).toBe("in_memory");
  expect(resolve_bridge_mode({ BRIDGE_MODE: "WebSocket" })).toBe("websocket");
});

test("resolve_bridge_mode fails fast for unsupported values", () => {
  expect(() => resolve_bridge_mode({ BRIDGE_MODE: "ws" })).toThrow(
    "BRIDGE_MODE must be either 'websocket' or 'in_memory'",
  );
});

test("resolve_daemon_mode defaults to auto for websocket mode", () => {
  expect(resolve_daemon_mode({}, "websocket")).toBe("auto");
});

test("resolve_daemon_mode forces direct mode for in-memory bridge", () => {
  expect(resolve_daemon_mode({ MCP_DAEMON_MODE: "auto" }, "in_memory")).toBe("direct");
});

test("resolve_daemon_mode validates configured values", () => {
  expect(resolve_daemon_mode({ MCP_DAEMON_MODE: "proxy" }, "websocket")).toBe("proxy");
  expect(resolve_daemon_mode({ MCP_DAEMON_MODE: "daemon" }, "websocket")).toBe("daemon");
  expect(() => resolve_daemon_mode({ MCP_DAEMON_MODE: "shared" }, "websocket")).toThrow(
    "MCP_DAEMON_MODE must be one of",
  );
});

test("resolve_daemon_port defaults to bridge_port + 1", () => {
  expect(resolve_daemon_port({}, 37777)).toBe(37778);
});

test("resolve_daemon_port accepts explicit values and guards invalid ones", () => {
  expect(resolve_daemon_port({ MCP_DAEMON_PORT: "39000" }, 37777)).toBe(39000);
  expect(resolve_daemon_port({ MCP_DAEMON_PORT: "0" }, 37777)).toBe(37778);
  expect(resolve_daemon_port({ MCP_DAEMON_PORT: "70000" }, 37777)).toBe(37778);
});

test("resolve_daemon timeout helpers apply defaults and parse env", () => {
  expect(resolve_daemon_idle_timeout_ms({})).toBe(900000);
  expect(resolve_daemon_idle_timeout_ms({ MCP_DAEMON_IDLE_TIMEOUT_MS: "1200000" })).toBe(1200000);
  expect(resolve_daemon_connect_timeout_ms({})).toBe(10000);
  expect(resolve_daemon_connect_timeout_ms({ MCP_DAEMON_CONNECT_TIMEOUT_MS: "25000" })).toBe(25000);
});
