import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

export interface extension_bundle_adapter {
  has_file: (relative_path: string) => boolean;
  read_text: (relative_path: string) => string;
}

export interface extension_bundle_validation_result {
  service_worker_path?: string;
  required_files: string[];
  module_files: string[];
  missing_files: string[];
  errors: string[];
}

interface module_graph_result {
  module_files: string[];
  missing_files: string[];
}

const required_extension_files = ["manifest.json", "popup.html", "popup.css", "popup.js", "README.md"];

export function normalize_relative_path(path: string): string {
  const normalized = path.replaceAll("\\", "/").trim();
  const without_leading = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  const collapsed = posix.normalize(without_leading);
  if (collapsed === "." || collapsed.length === 0) {
    return "";
  }

  return collapsed;
}

export function parse_module_import_specifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const static_import_pattern = /(?:^|[\n\r;])\s*import\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/gm;
  const dynamic_import_pattern = /import\s*\(\s*["']([^"']+)["']\s*\)/gm;
  const export_from_pattern = /(?:^|[\n\r;])\s*export\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/gm;

  for (const pattern of [static_import_pattern, dynamic_import_pattern, export_from_pattern]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(source);
    while (match) {
      const specifier = match[1]?.trim();
      if (specifier && specifier.length > 0) {
        specifiers.add(specifier);
      }
      match = pattern.exec(source);
    }
  }

  return [...specifiers];
}

function resolve_relative_import_target(importer_relative_path: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return undefined;
  }

  const importer_directory = posix.dirname(importer_relative_path);
  const resolved = posix.normalize(posix.join(importer_directory, specifier));
  if (resolved.startsWith("../")) {
    return undefined;
  }

  return resolved;
}

function resolve_existing_module_path(
  module_candidate: string,
  has_file: (relative_path: string) => boolean,
): string | undefined {
  const normalized_candidate = normalize_relative_path(module_candidate);
  if (normalized_candidate.length === 0) {
    return undefined;
  }

  if (has_file(normalized_candidate)) {
    return normalized_candidate;
  }

  if (!posix.extname(normalized_candidate)) {
    const with_js = `${normalized_candidate}.js`;
    if (has_file(with_js)) {
      return with_js;
    }

    const as_index_js = `${normalized_candidate}/index.js`;
    if (has_file(as_index_js)) {
      return as_index_js;
    }
  }

  return undefined;
}

function collect_module_graph(
  entry_path: string,
  adapter: extension_bundle_adapter,
): module_graph_result {
  const visited_files = new Set<string>();
  const module_files = new Set<string>();
  const missing_files = new Set<string>();
  const queue: string[] = [entry_path];

  while (queue.length > 0) {
    const current_file = queue.shift();
    if (!current_file) {
      continue;
    }

    const normalized_current = normalize_relative_path(current_file);
    if (normalized_current.length === 0) {
      continue;
    }

    if (visited_files.has(normalized_current)) {
      continue;
    }

    visited_files.add(normalized_current);
    if (!adapter.has_file(normalized_current)) {
      missing_files.add(normalized_current);
      continue;
    }

    module_files.add(normalized_current);
    const source = adapter.read_text(normalized_current);
    const import_specifiers = parse_module_import_specifiers(source);

    for (const specifier of import_specifiers) {
      const relative_target = resolve_relative_import_target(normalized_current, specifier);
      if (!relative_target) {
        continue;
      }

      const resolved_target = resolve_existing_module_path(relative_target, adapter.has_file);
      if (!resolved_target) {
        missing_files.add(normalize_relative_path(relative_target));
        continue;
      }

      if (!visited_files.has(resolved_target)) {
        queue.push(resolved_target);
      }
    }
  }

  return {
    module_files: [...module_files].sort((left, right) => left.localeCompare(right)),
    missing_files: [...missing_files].sort((left, right) => left.localeCompare(right)),
  };
}

export function validate_extension_bundle_entries(adapter: extension_bundle_adapter): extension_bundle_validation_result {
  const errors: string[] = [];
  const missing_files = new Set<string>();

  for (const required_file of required_extension_files) {
    if (!adapter.has_file(required_file)) {
      missing_files.add(required_file);
    }
  }

  if (!adapter.has_file("manifest.json")) {
    errors.push("manifest.json is missing");
    return {
      required_files: [...required_extension_files],
      module_files: [],
      missing_files: [...missing_files].sort((left, right) => left.localeCompare(right)),
      errors,
    };
  }

  let service_worker_path: string | undefined;
  try {
    const manifest = JSON.parse(adapter.read_text("manifest.json")) as {
      background?: {
        service_worker?: unknown;
      };
    };
    if (typeof manifest.background?.service_worker === "string") {
      service_worker_path = normalize_relative_path(manifest.background.service_worker);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`failed to parse manifest.json: ${message}`);
  }

  if (!service_worker_path || service_worker_path.length === 0) {
    errors.push("manifest background.service_worker must be a non-empty string");
    return {
      required_files: [...required_extension_files],
      module_files: [],
      missing_files: [...missing_files].sort((left, right) => left.localeCompare(right)),
      errors,
    };
  }

  const module_graph = collect_module_graph(service_worker_path, adapter);
  for (const missing_file of module_graph.missing_files) {
    missing_files.add(missing_file);
  }

  return {
    service_worker_path,
    required_files: [...required_extension_files],
    module_files: module_graph.module_files,
    missing_files: [...missing_files].sort((left, right) => left.localeCompare(right)),
    errors,
  };
}

function collect_extension_files_recursively(extension_root: string): Set<string> {
  const files = new Set<string>();

  function walk(directory_path: string): void {
    const entries = readdirSync(directory_path);
    for (const entry of entries) {
      const absolute_path = join(directory_path, entry);
      const stats = statSync(absolute_path);
      if (stats.isDirectory()) {
        walk(absolute_path);
        continue;
      }

      if (!stats.isFile()) {
        continue;
      }

      const relative_path = absolute_path
        .slice(extension_root.length + 1)
        .replaceAll("\\", "/");
      files.add(relative_path);
    }
  }

  walk(extension_root);
  return files;
}

export function resolve_extension_stage_file_entries(extension_root: string): string[] {
  const absolute_extension_root = resolve(extension_root);
  const available_files = collect_extension_files_recursively(absolute_extension_root);
  const adapter: extension_bundle_adapter = {
    has_file: (relative_path) => available_files.has(normalize_relative_path(relative_path)),
    read_text: (relative_path) => readFileSync(join(absolute_extension_root, normalize_relative_path(relative_path)), "utf8"),
  };

  const validation = validate_extension_bundle_entries(adapter);
  if (validation.errors.length > 0 || validation.missing_files.length > 0) {
    const error_lines = [
      "[release] extension stage validation failed",
      ...validation.errors.map((entry) => `- ${entry}`),
      ...validation.missing_files.map((entry) => `- missing: ${entry}`),
    ];
    throw new Error(error_lines.join("\n"));
  }

  const stage_entries = new Set<string>([
    "manifest.json",
    "popup.html",
    "popup.css",
    "popup.js",
    "assets",
    "README.md",
  ]);

  for (const module_file of validation.module_files) {
    stage_entries.add(module_file);
  }

  if (validation.service_worker_path) {
    stage_entries.add(validation.service_worker_path);
  }

  return [...stage_entries].sort((left, right) => left.localeCompare(right));
}
