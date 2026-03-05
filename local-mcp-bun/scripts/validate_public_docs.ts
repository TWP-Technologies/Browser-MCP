#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface public_docs_input {
  readme_text: string;
  privacy_text: string;
}

function has_line_matching(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function require_line_match(errors: string[], text: string, pattern: RegExp, message: string): void {
  if (!has_line_matching(text, pattern)) {
    errors.push(message);
  }
}

export function validate_public_docs(input: public_docs_input): string[] {
  const errors: string[] = [];
  const readme_text = input.readme_text;
  const privacy_text = input.privacy_text;

  require_line_match(errors, readme_text, /^# .*(MCP|Model Context Protocol)/im, "README must have an MCP heading");
  require_line_match(
    errors,
    readme_text,
    /chrome-browser-mcp-chrome-extension-v<version>\.zip/i,
    "README must reference release extension zip naming",
  );
  require_line_match(errors, readme_text, /chrome:\/\/extensions/i, "README must mention chrome://extensions");
  require_line_match(errors, readme_text, /Load unpacked/i, "README must include Load unpacked step");
  require_line_match(errors, readme_text, /chmod \+x/i, "README must include executable permission guidance");
  require_line_match(errors, readme_text, /\bcodex mcp add\b/i, "README must include Codex MCP setup command");
  require_line_match(errors, readme_text, /\bclaude mcp add\b/i, "README must include Claude Code MCP setup command");
  require_line_match(errors, readme_text, /\bgemini mcp add\b/i, "README must include Gemini CLI MCP setup command");
  require_line_match(errors, readme_text, /PRIVACY\.md/i, "README must link to PRIVACY.md");
  require_line_match(errors, readme_text, /BRIDGE_PORT=37777/i, "README must document default bridge port");
  require_line_match(
    errors,
    readme_text,
    /\b(do|does)\b[\s\S]{0,30}\bnot\b[\s\S]{0,40}\b(send|store|collect)\b/i,
    "README privacy section must state no remote collection/storage by this project",
  );
  require_line_match(errors, readme_text, /prompt-injection/i, "README must warn about prompt-injection risk");

  require_line_match(errors, privacy_text, /^# Privacy Policy$/im, "PRIVACY.md must include title");
  require_line_match(errors, privacy_text, /\bUser activity\b/i, "PRIVACY.md must declare User activity category");
  require_line_match(errors, privacy_text, /\bWebsite content\b/i, "PRIVACY.md must declare Website content category");
  require_line_match(
    errors,
    privacy_text,
    /\b(do|does)\b[\s\S]{0,30}\bnot\b[\s\S]{0,40}\b(collect|store)\b/i,
    "PRIVACY.md must state no project-operated remote collection/storage",
  );
  require_line_match(
    errors,
    privacy_text,
    /(outside this project'?s control|outside this project’s control)/i,
    "PRIVACY.md must note third-party agent/provider handling is outside project control",
  );

  return errors;
}

function main(): void {
  const repository_root = resolve(process.cwd(), "..");
  const readme_path = resolve(repository_root, "README.md");
  const privacy_path = resolve(repository_root, "PRIVACY.md");

  if (!existsSync(readme_path)) {
    console.error(`[public-docs] FAIL: missing required file ${readme_path}`);
    process.exit(1);
  }

  if (!existsSync(privacy_path)) {
    console.error(`[public-docs] FAIL: missing required file ${privacy_path}`);
    process.exit(1);
  }

  const readme_text = readFileSync(readme_path, "utf8");
  const privacy_text = readFileSync(privacy_path, "utf8");
  const errors = validate_public_docs({
    readme_text,
    privacy_text,
  });

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[public-docs] FAIL: ${error}`);
    }
    process.exit(1);
  }

  console.log("[public-docs] PASS");
}

if (import.meta.main) {
  main();
}
