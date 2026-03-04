import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface package_json_version {
  version?: string;
}

interface extension_manifest_version {
  version?: string;
}

interface version_sync_input {
  package_version: string;
  manifest_version: string;
  release_version?: string;
}

function read_json_file<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as T;
}

function get_cli_option(option_name: string): string | undefined {
  const prefix = `--${option_name}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
    const entry = process.argv[index];
    if (entry.startsWith(prefix)) {
      return entry.slice(prefix.length).trim();
    }

    if (entry === `--${option_name}`) {
      const next_entry = process.argv[index + 1];
      if (typeof next_entry === "string" && next_entry.trim().length > 0) {
        return next_entry.trim();
      }
    }
  }

  return undefined;
}

export function normalize_release_version(input: string): string {
  const trimmed = input.trim();
  const stripped = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  const semver_like_pattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  if (!semver_like_pattern.test(stripped)) {
    throw new Error(`release version must be semantic-looking (vX.Y.Z or X.Y.Z), received '${input}'`);
  }

  return stripped;
}

export function assert_release_version_sync(input: version_sync_input): void {
  if (input.package_version !== input.manifest_version) {
    throw new Error(
      `version mismatch: package.json=${input.package_version} manifest.json=${input.manifest_version} (must match)`,
    );
  }

  if (typeof input.release_version === "string" && input.release_version.length > 0) {
    if (input.release_version !== input.package_version) {
      throw new Error(
        `version mismatch: release=${input.release_version} package.json=${input.package_version} manifest.json=${input.manifest_version}`,
      );
    }
  }
}

function run_cli(): void {
  const project_root = resolve(import.meta.dir, "..");
  const package_json_path = resolve(project_root, "package.json");
  const manifest_path = resolve(project_root, "chrome-extension/manifest.json");

  const package_json = read_json_file<package_json_version>(package_json_path);
  const manifest = read_json_file<extension_manifest_version>(manifest_path);

  const package_version = typeof package_json.version === "string" ? package_json.version.trim() : "";
  const manifest_version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (package_version.length === 0 || manifest_version.length === 0) {
    throw new Error("package.json and manifest.json must both define a non-empty version");
  }

  const release_version_input = get_cli_option("version") ?? process.env.RELEASE_VERSION;
  const release_version =
    typeof release_version_input === "string" && release_version_input.trim().length > 0
      ? normalize_release_version(release_version_input)
      : undefined;

  assert_release_version_sync({
    package_version,
    manifest_version,
    release_version,
  });

  if (typeof release_version === "string") {
    console.log(`[release] version sync ok: ${release_version}`);
    return;
  }

  console.log(`[release] version sync ok (package+manifest): ${package_version}`);
}

if (import.meta.main) {
  try {
    run_cli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release] version check failed: ${message}`);
    process.exit(1);
  }
}
