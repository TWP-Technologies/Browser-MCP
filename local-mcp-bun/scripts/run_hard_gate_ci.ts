const skip_windows_e2e = process.platform === "win32" && process.env.FORCE_WINDOWS_E2E !== "1";

const step_scripts = skip_windows_e2e
  ? ["test:unit", "test:integration", "test:fault", "test:concurrency"]
  : ["test:unit", "test:integration", "test:e2e", "test:fault", "test:concurrency"];

if (skip_windows_e2e) {
  console.warn(
    "[hard-gate-ci] skipping test:e2e on win32 because extension persistent context launch times out on GitHub-hosted Windows runners",
  );
}

for (const script_name of step_scripts) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", script_name],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

console.log("[hard-gate-ci] PASS");
