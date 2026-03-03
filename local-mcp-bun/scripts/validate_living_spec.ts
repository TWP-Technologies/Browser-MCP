#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";

function fail(message: string): never {
  console.error(`[living-spec] FAIL: ${message}`);
  process.exit(1);
}

function main(): void {
  const spec_path = "../specs/local-multiplexed-browser-mcp-spec.md";
  const resolved_path = new URL(spec_path, `file://${process.cwd()}/`).pathname;

  if (!existsSync(resolved_path)) {
    fail(`missing required spec file: ${resolved_path}`);
  }

  const text = readFileSync(resolved_path, "utf8");

  const required_phrases = [
    "Living Spec",
    "local-mcp-bun/chrome-extension/",
    "list_available_tabs",
    "attach_to_tab",
    "detach_from_tab"
  ];

  for (const phrase of required_phrases) {
    if (!text.includes(phrase)) {
      fail(`spec missing required phrase: ${phrase}`);
    }
  }

  console.log("[living-spec] PASS");
}

main();
