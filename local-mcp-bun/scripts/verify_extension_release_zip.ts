#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync } from "fflate";
import { normalize_relative_path, validate_extension_bundle_entries } from "./extension_bundle_integrity";

interface cli_options {
  zip_path: string;
}

function parse_cli_options(argv: string[]): cli_options {
  let zip_path = "";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--zip") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--zip requires a value");
      }

      zip_path = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--zip=")) {
      zip_path = argument.slice("--zip=".length).trim();
      continue;
    }
  }

  if (zip_path.length === 0) {
    throw new Error("missing --zip <path> argument");
  }

  return {
    zip_path: resolve(zip_path),
  };
}

function decode_entry(bytes: Uint8Array): string {
  return new TextDecoder("utf8").decode(bytes);
}

function main(): void {
  const options = parse_cli_options(process.argv.slice(2));
  const zip_content = readFileSync(options.zip_path);
  const zip_entries = unzipSync(new Uint8Array(zip_content));
  const entry_names = new Set<string>(Object.keys(zip_entries).map((entry) => normalize_relative_path(entry)));

  const validation = validate_extension_bundle_entries({
    has_file: (relative_path) => entry_names.has(normalize_relative_path(relative_path)),
    read_text: (relative_path) => {
      const normalized_path = normalize_relative_path(relative_path);
      const entry = zip_entries[normalized_path];
      if (!entry) {
        throw new Error(`zip entry not found: ${normalized_path}`);
      }

      return decode_entry(entry);
    },
  });

  if (validation.errors.length > 0 || validation.missing_files.length > 0) {
    for (const error of validation.errors) {
      console.error(`[release-verify] error: ${error}`);
    }

    for (const missing_file of validation.missing_files) {
      console.error(`[release-verify] missing: ${missing_file}`);
    }

    console.error(`[release-verify] FAIL ${options.zip_path}`);
    process.exit(1);
  }

  console.log(
    `[release-verify] PASS ${options.zip_path} (service_worker=${validation.service_worker_path}, modules=${validation.module_files.length})`,
  );
}

main();
