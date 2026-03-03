#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

type output_format = "text" | "json";

interface cli_options {
  root: string;
  format: output_format;
}

interface compliance_rule {
  rule_id: string;
  requirement_ids: string[];
  kind: "forbidden_token" | "required_notice";
  description: string;
  token?: string;
  file_path?: string;
  required_text?: string;
}

interface compliance_violation {
  rule_id: string;
  requirement_ids: string[];
  file_path: string;
  message: string;
}

interface compliance_report {
  status: "PASS" | "FAIL";
  root: string;
  checked_file_count: number;
  rules: Array<{
    rule_id: string;
    requirement_ids: string[];
    description: string;
  }>;
  violations: compliance_violation[];
}

const required_notice = "Modified by [KnotFalse]";

const compliance_rules: compliance_rule[] = [
  {
    rule_id: "CR-001",
    requirement_ids: ["FR-018"],
    kind: "forbidden_token",
    description: "Forbidden remote relay endpoint must not appear",
    token: "mcp-for-chrome.railsblueprint.com",
  },
  {
    rule_id: "CR-002",
    requirement_ids: ["FR-018"],
    kind: "forbidden_token",
    description: "Rails Blueprint trademark text must not appear",
    token: "Rails Blueprint",
  },
  {
    rule_id: "CR-003",
    requirement_ids: ["FR-018"],
    kind: "forbidden_token",
    description: "railsblueprint branding token must not appear",
    token: "railsblueprint",
  },
  {
    rule_id: "CR-004",
    requirement_ids: ["FR-018"],
    kind: "required_notice",
    description: "Project README must include modification notice",
    file_path: "README.md",
    required_text: required_notice,
  },
  {
    rule_id: "CR-005",
    requirement_ids: ["FR-018"],
    kind: "required_notice",
    description: "Extension background worker must include modification notice",
    file_path: "chrome-extension/background.js",
    required_text: required_notice,
  },
  {
    rule_id: "CR-006",
    requirement_ids: ["FR-018"],
    kind: "required_notice",
    description: "Extension README must include modification notice",
    file_path: "chrome-extension/README.md",
    required_text: required_notice,
  },
];

function parse_cli_options(argv: string[]): cli_options {
  let root = process.cwd();
  let format: output_format = "text";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires a path value");
      }

      root = resolve(value);
      index += 1;
      continue;
    }

    if (argument === "--format") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--format requires a value of 'text' or 'json'");
      }

      if (value !== "text" && value !== "json") {
        throw new Error(`unsupported --format value '${value}'`);
      }

      format = value;
      index += 1;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      print_usage();
      process.exit(0);
    }
  }

  return { root, format };
}

function print_usage(): void {
  console.log("Usage: bun run scripts/compliance_scan.ts [--root <path>] [--format text|json]");
}

function should_scan_file(path: string): boolean {
  return (
    path.endsWith(".ts") ||
    path.endsWith(".js") ||
    path.endsWith(".md") ||
    path.endsWith(".json") ||
    path.endsWith(".yml") ||
    path.endsWith(".yaml")
  );
}

function should_ignore_path(path: string, ignore_fixture_paths: boolean): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.includes("/node_modules/") ||
    normalized.includes("/.git/") ||
    (ignore_fixture_paths && normalized.includes("/tests/fixtures/")) ||
    normalized.includes("/ci-evidence/") ||
    normalized.includes("/coverage/")
  );
}

function walk_files(root: string, ignore_fixture_paths: boolean): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === ".idea") {
      continue;
    }

    const full_path = join(root, entry);
    if (should_ignore_path(full_path, ignore_fixture_paths)) {
      continue;
    }

    const stats = statSync(full_path);

    if (stats.isDirectory()) {
      files.push(...walk_files(full_path, ignore_fixture_paths));
      continue;
    }

    files.push(full_path);
  }

  return files;
}

function to_relative_path(root: string, absolute_path: string): string {
  const normalized_root = root.endsWith("/") ? root : `${root}/`;
  if (!absolute_path.startsWith(normalized_root)) {
    return absolute_path;
  }

  return absolute_path.slice(normalized_root.length);
}

function build_report(root: string): compliance_report {
  const normalized_root = root.replaceAll("\\", "/");
  const ignore_fixture_paths = !normalized_root.includes("/tests/fixtures/");
  const scanned_files = walk_files(root, ignore_fixture_paths).filter((path) => should_scan_file(path));
  const violations: compliance_violation[] = [];

  const forbidden_rules = compliance_rules.filter((rule) => rule.kind === "forbidden_token");
  const required_rules = compliance_rules.filter((rule) => rule.kind === "required_notice");

  for (const file of scanned_files) {
    const normalized_file = file.replaceAll("\\", "/");
    if (normalized_file.endsWith("/scripts/compliance_scan.ts") || normalized_file.endsWith("scripts/compliance_scan.ts")) {
      continue;
    }

    const text = readFileSync(file, "utf8");
    const relative_file = to_relative_path(root, file);

    for (const rule of forbidden_rules) {
      const token = rule.token as string;
      if (!text.includes(token)) {
        continue;
      }

      violations.push({
        rule_id: rule.rule_id,
        requirement_ids: rule.requirement_ids,
        file_path: relative_file,
        message: `forbidden token '${token}' found`,
      });
    }
  }

  for (const rule of required_rules) {
    const target_file = join(root, rule.file_path as string);
    if (!existsSync(target_file)) {
      violations.push({
        rule_id: rule.rule_id,
        requirement_ids: rule.requirement_ids,
        file_path: rule.file_path as string,
        message: "required file not found",
      });
      continue;
    }

    const text = readFileSync(target_file, "utf8");
    const required_text = rule.required_text as string;
    if (text.includes(required_text)) {
      continue;
    }

    violations.push({
      rule_id: rule.rule_id,
      requirement_ids: rule.requirement_ids,
      file_path: rule.file_path as string,
      message: `missing required text '${required_text}'`,
    });
  }

  return {
    status: violations.length === 0 ? "PASS" : "FAIL",
    root,
    checked_file_count: scanned_files.length,
    rules: compliance_rules.map((rule) => ({
      rule_id: rule.rule_id,
      requirement_ids: rule.requirement_ids,
      description: rule.description,
    })),
    violations,
  };
}

function print_text_report(report: compliance_report): void {
  if (report.status === "PASS") {
    console.log(
      `[compliance] PASS (root=${report.root}, checked_files=${report.checked_file_count}, rules=${report.rules.length})`,
    );
    return;
  }

  for (const violation of report.violations) {
    console.error(
      `[compliance][${violation.rule_id}][${violation.requirement_ids.join(",")}] ${violation.file_path}: ${violation.message}`,
    );
  }

  console.error(
    `[compliance] FAIL (root=${report.root}, checked_files=${report.checked_file_count}, violations=${report.violations.length})`,
  );
}

function main(): void {
  const options = parse_cli_options(process.argv.slice(2));
  const report = build_report(options.root);

  if (options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    print_text_report(report);
  }

  if (report.status === "FAIL") {
    process.exit(1);
  }
}

main();
