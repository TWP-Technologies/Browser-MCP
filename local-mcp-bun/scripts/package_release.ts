import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { zipSync } from "fflate";
import { assert_release_version_sync, normalize_release_version } from "./check_release_version_sync";

interface package_json_version {
  version?: string;
}

interface extension_manifest_version {
  version?: string;
}

type package_mode = "server" | "extension" | "all";

interface package_cli_options {
  mode: package_mode;
  version?: string;
  out_dir: string;
  clean: boolean;
}

const release_asset_prefix = "local-mcp";

function read_json_file<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
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

function has_cli_flag(flag_name: string): boolean {
  return process.argv.includes(`--${flag_name}`);
}

function parse_package_mode(input: string | undefined): package_mode {
  if (typeof input !== "string" || input.length === 0) {
    return "all";
  }

  if (input === "server" || input === "extension" || input === "all") {
    return input;
  }

  throw new Error(`invalid --mode '${input}' (expected: server | extension | all)`);
}

function parse_cli_options(project_root: string): package_cli_options {
  const mode = parse_package_mode(get_cli_option("mode"));
  const version_input = get_cli_option("version");
  const out_dir_input = get_cli_option("out-dir");

  return {
    mode,
    version:
      typeof version_input === "string" && version_input.trim().length > 0
        ? normalize_release_version(version_input)
        : undefined,
    out_dir:
      typeof out_dir_input === "string" && out_dir_input.trim().length > 0
        ? resolve(project_root, out_dir_input.trim())
        : resolve(project_root, "dist/release"),
    clean: has_cli_flag("clean"),
  };
}

function read_project_versions(project_root: string): {
  package_version: string;
  manifest_version: string;
} {
  const package_json = read_json_file<package_json_version>(resolve(project_root, "package.json"));
  const manifest = read_json_file<extension_manifest_version>(resolve(project_root, "chrome-extension/manifest.json"));

  const package_version = typeof package_json.version === "string" ? package_json.version.trim() : "";
  const manifest_version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  if (package_version.length === 0 || manifest_version.length === 0) {
    throw new Error("package.json and manifest.json must both define a non-empty version");
  }

  return {
    package_version,
    manifest_version,
  };
}

function run_checked_command(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(" ")}`);
  }
}

function resolve_platform_label(): string {
  if (process.platform === "darwin") {
    return "macos";
  }

  if (process.platform === "win32") {
    return "windows";
  }

  return process.platform;
}

function resolve_arch_label(): string {
  if (process.arch === "x64" || process.arch === "arm64") {
    return process.arch;
  }

  return process.arch;
}

function format_release_version_dir_name(version: string): string {
  return `v${version}`;
}

function format_server_artifact_file_name(version: string): string {
  const platform_label = resolve_platform_label();
  const arch_label = resolve_arch_label();
  const extension = process.platform === "win32" ? ".exe" : "";
  return `${release_asset_prefix}-v${version}-${platform_label}-${arch_label}${extension}`;
}

function collect_directory_files(directory_path: string): string[] {
  const entries = readdirSync(directory_path);
  const files: string[] = [];

  for (const entry of entries) {
    const absolute_path = join(directory_path, entry);
    const stats = statSync(absolute_path);
    if (stats.isDirectory()) {
      files.push(...collect_directory_files(absolute_path));
      continue;
    }

    if (stats.isFile()) {
      files.push(absolute_path);
    }
  }

  return files;
}

function copy_extension_release_files(project_root: string, stage_dir: string): void {
  const extension_root = resolve(project_root, "chrome-extension");
  const selected_entries = ["manifest.json", "background.js", "popup.html", "popup.css", "popup.js", "assets", "README.md"];

  for (const entry of selected_entries) {
    const source_path = resolve(extension_root, entry);
    const destination_path = resolve(stage_dir, entry);
    cpSync(source_path, destination_path, { recursive: true, force: true });
  }
}

function create_zip_archive_from_directory(stage_dir: string, archive_path: string): void {
  const stage_files = collect_directory_files(stage_dir);
  const zip_entries: Record<string, Uint8Array> = {};

  for (const absolute_file_path of stage_files) {
    const relative_path = relative(stage_dir, absolute_file_path).replaceAll("\\", "/");
    zip_entries[relative_path] = new Uint8Array(readFileSync(absolute_file_path));
  }

  const archive_content = zipSync(zip_entries, { level: 9 });
  writeFileSync(archive_path, archive_content);
}

function sha256_hex_of_file(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function write_checksums_file(output_dir: string, artifact_paths: string[]): string {
  const lines = artifact_paths
    .map((artifact_path) => `${sha256_hex_of_file(artifact_path)}  ${basename(artifact_path)}`)
    .sort((left, right) => left.localeCompare(right));

  const checksums_path = resolve(output_dir, "SHA256SUMS.txt");
  writeFileSync(checksums_path, `${lines.join("\n")}\n`, "utf8");
  return checksums_path;
}

function package_server_binary(project_root: string, output_dir: string, version: string): string {
  const server_file_name = format_server_artifact_file_name(version);
  const output_path = resolve(output_dir, server_file_name);
  run_checked_command("bun", ["build", "--compile", "--outfile", output_path, "src/index.ts"], project_root);
  return output_path;
}

function package_extension_bundle(project_root: string, output_dir: string, version: string): string {
  run_checked_command("bun", ["run", "build:popup-ui"], project_root);

  const stage_dir = resolve(output_dir, "extension-stage");
  rmSync(stage_dir, { recursive: true, force: true });
  mkdirSync(stage_dir, { recursive: true });
  copy_extension_release_files(project_root, stage_dir);

  const extension_archive_path = resolve(output_dir, `${release_asset_prefix}-chrome-extension-v${version}.zip`);
  create_zip_archive_from_directory(stage_dir, extension_archive_path);
  rmSync(stage_dir, { recursive: true, force: true });

  return extension_archive_path;
}

function run_package_release(): void {
  const project_root = resolve(import.meta.dir, "..");
  const options = parse_cli_options(project_root);
  const project_versions = read_project_versions(project_root);

  assert_release_version_sync({
    ...project_versions,
    release_version: options.version,
  });

  const version = options.version ?? project_versions.package_version;
  const output_dir = resolve(options.out_dir, format_release_version_dir_name(version));
  if (options.clean) {
    rmSync(output_dir, { recursive: true, force: true });
  }
  mkdirSync(output_dir, { recursive: true });

  const artifacts: string[] = [];
  if (options.mode === "server" || options.mode === "all") {
    artifacts.push(package_server_binary(project_root, output_dir, version));
  }

  if (options.mode === "extension" || options.mode === "all") {
    artifacts.push(package_extension_bundle(project_root, output_dir, version));
  }

  if (artifacts.length === 0) {
    throw new Error("no artifacts were produced");
  }

  const checksums_path = write_checksums_file(output_dir, artifacts);
  const relative_output_dir = relative(project_root, output_dir).replaceAll("\\", "/");

  console.log(`[release] packaged ${artifacts.length} artifact(s) into ${relative_output_dir}`);
  for (const artifact_path of artifacts) {
    console.log(`[release] artifact: ${basename(artifact_path)}`);
  }
  console.log(`[release] checksums: ${basename(checksums_path)}`);
}

if (import.meta.main) {
  try {
    run_package_release();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release] packaging failed: ${message}`);
    process.exit(1);
  }
}
