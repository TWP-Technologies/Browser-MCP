import { expect, test } from "bun:test";
import { socket_attempt_lifecycle } from "../../chrome-extension/socket_attempt_lifecycle.js";

test("socket_attempt_lifecycle allows first terminal event to win", () => {
  const lifecycle = new socket_attempt_lifecycle();
  lifecycle.begin(42);

  expect(lifecycle.claim_terminal(42)).toBe(true);
  expect(lifecycle.claim_terminal(42)).toBe(false);
});

test("socket_attempt_lifecycle ignores stale generations", () => {
  const lifecycle = new socket_attempt_lifecycle();
  lifecycle.begin(10);

  expect(lifecycle.claim_terminal(9)).toBe(false);
  expect(lifecycle.get_active_generation()).toBe(10);
});

test("socket_attempt_lifecycle switches active generation on reconnect", () => {
  const lifecycle = new socket_attempt_lifecycle();
  lifecycle.begin(100);
  lifecycle.begin(101);

  expect(lifecycle.claim_terminal(100)).toBe(false);
  expect(lifecycle.claim_terminal(101)).toBe(true);
  expect(lifecycle.get_active_generation()).toBe(null);
});

test("socket_attempt_lifecycle clear resets state", () => {
  const lifecycle = new socket_attempt_lifecycle();
  lifecycle.begin(3);
  lifecycle.clear();

  expect(lifecycle.get_active_generation()).toBe(null);
  expect(lifecycle.claim_terminal(3)).toBe(false);
});
