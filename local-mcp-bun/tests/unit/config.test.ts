import { expect, test } from "bun:test";
import { assert_loopback_host, is_loopback_host, resolve_auth_token } from "../../src/config";

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
