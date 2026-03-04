import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parse_module_import_specifiers,
  resolve_extension_stage_file_entries,
  validate_extension_bundle_entries,
} from "../../scripts/extension_bundle_integrity";

describe("parse_module_import_specifiers", () => {
  test("collects static, dynamic, and export-from specifiers", () => {
    const specifiers = parse_module_import_specifiers(`
      import { foo } from "./foo.js";
      import "./bar.js";
      const dynamic_value = await import("./dynamic.js");
      export { value } from "./exports.js";
    `);

    expect(specifiers).toEqual(["./foo.js", "./bar.js", "./dynamic.js", "./exports.js"]);
  });
});

describe("validate_extension_bundle_entries", () => {
  test("reports missing imported background modules", () => {
    const files = new Map<string, string>([
      [
        "manifest.json",
        JSON.stringify({
          background: {
            service_worker: "background.js",
            type: "module",
          },
        }),
      ],
      ["background.js", 'import "./reconnect_scheduler.js";'],
      ["popup.html", "<html></html>"],
      ["popup.css", "body{}"],
      ["popup.js", "console.log('ok');"],
      ["README.md", "# test"],
    ]);

    const result = validate_extension_bundle_entries({
      has_file: (relative_path) => files.has(relative_path),
      read_text: (relative_path) => {
        const value = files.get(relative_path);
        if (typeof value !== "string") {
          throw new Error(`missing test file: ${relative_path}`);
        }

        return value;
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.service_worker_path).toBe("background.js");
    expect(result.missing_files).toContain("reconnect_scheduler.js");
  });
});

describe("resolve_extension_stage_file_entries", () => {
  test("includes transitive background imports for release packaging", () => {
    const extension_root = resolve(import.meta.dir, "../../chrome-extension");
    const entries = resolve_extension_stage_file_entries(extension_root);

    expect(entries).toContain("background.js");
    expect(entries).toContain("reconnect_scheduler.js");
    expect(entries).toContain("socket_attempt_lifecycle.js");
  });

  test("throws when required module files are missing", () => {
    const temp_dir = mkdtempSync(join(tmpdir(), "extension-integrity-"));
    const extension_root = join(temp_dir, "chrome-extension");
    mkdirSync(extension_root, { recursive: true });
    mkdirSync(join(extension_root, "assets"), { recursive: true });
    writeFileSync(
      join(extension_root, "manifest.json"),
      JSON.stringify({
        background: {
          service_worker: "background.js",
          type: "module",
        },
      }),
    );
    writeFileSync(join(extension_root, "background.js"), 'import "./missing_module.js";');
    writeFileSync(join(extension_root, "popup.html"), "<html></html>");
    writeFileSync(join(extension_root, "popup.css"), "body{}");
    writeFileSync(join(extension_root, "popup.js"), "console.log('ok');");
    writeFileSync(join(extension_root, "README.md"), "# test");

    try {
      expect(() => resolve_extension_stage_file_entries(extension_root)).toThrow(/missing: missing_module\.js/);
    } finally {
      rmSync(temp_dir, { recursive: true, force: true });
    }
  });
});
