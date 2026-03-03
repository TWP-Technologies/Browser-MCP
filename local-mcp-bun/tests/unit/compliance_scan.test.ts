import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface scan_report {
  status: "PASS" | "FAIL";
  violations: Array<{
    rule_id: string;
    requirement_ids: string[];
    file_path: string;
    message: string;
  }>;
  rules: Array<{
    rule_id: string;
    requirement_ids: string[];
    description: string;
  }>;
}

const current_dir = dirname(fileURLToPath(import.meta.url));
const script_path = resolve(current_dir, "../../scripts/compliance_scan.ts");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function run_scan(fixture_path: string): { exit_code: number; report: scan_report } {
  const subprocess = Bun.spawnSync({
    cmd: ["bun", "run", script_path, "--root", fixture_path, "--format", "json"],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout_text = decode(subprocess.stdout);
  const stderr_text = decode(subprocess.stderr);

  if (!stdout_text.trim()) {
    throw new Error(`expected JSON report on stdout, received stderr: ${stderr_text}`);
  }

  return {
    exit_code: subprocess.exitCode,
    report: JSON.parse(stdout_text) as scan_report,
  };
}

test("compliance scan passes clean fixture and maps rules to FR-018", () => {
  const fixture_path = resolve(current_dir, "../fixtures/compliance/pass");
  const result = run_scan(fixture_path);

  expect(result.exit_code).toBe(0);
  expect(result.report.status).toBe("PASS");
  expect(result.report.violations.length).toBe(0);
  expect(result.report.rules.some((rule) => rule.rule_id === "CR-001")).toBe(true);
  expect(result.report.rules.every((rule) => rule.requirement_ids.includes("FR-018"))).toBe(true);
});

test("compliance scan fails on forbidden endpoint token", () => {
  const fixture_path = resolve(current_dir, "../fixtures/compliance/fail-forbidden");
  const result = run_scan(fixture_path);

  expect(result.exit_code).toBe(1);
  expect(result.report.status).toBe("FAIL");
  expect(result.report.violations.some((violation) => violation.rule_id === "CR-001")).toBe(true);
});

test("compliance scan fails on missing required notice", () => {
  const fixture_path = resolve(current_dir, "../fixtures/compliance/fail-missing-notice");
  const result = run_scan(fixture_path);

  expect(result.exit_code).toBe(1);
  expect(result.report.status).toBe("FAIL");
  expect(result.report.violations.some((violation) => violation.rule_id === "CR-004")).toBe(true);
});
