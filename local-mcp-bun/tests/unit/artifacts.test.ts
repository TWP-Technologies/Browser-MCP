// Modified by [KnotFalse]
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool_error } from "../../src/errors";
import {
  prepare_artifact_destination,
  resolve_artifact_path,
  resolve_artifact_root,
  resolve_default_artifact_root,
  write_artifact_file,
} from "../../src/artifacts";

const deleted_cwd_test = process.platform === "win32" ? test.skip : test;
const symlink_test = process.platform === "win32" ? test.skip : test;

deleted_cwd_test("resolve_default_artifact_root falls back when cwd no longer exists", () => {
  const original_cwd = process.cwd();
  const deleted_cwd = mkdtempSync(join(tmpdir(), "local-mcp-deleted-cwd-"));

  try {
    process.chdir(deleted_cwd);
    rmSync(deleted_cwd, { recursive: true, force: true });

    const artifact_root_context = resolve_default_artifact_root();
    expect(artifact_root_context.artifact_root_real).toBe(realpathSync(tmpdir()));
  } finally {
    process.chdir(original_cwd);
    rmSync(deleted_cwd, { recursive: true, force: true });
  }
});

test("resolve_artifact_path allows child names that start with two dots", () => {
  const artifact_root = mkdtempSync(join(tmpdir(), "local-mcp-dot-prefix-root-"));

  try {
    const root_context = resolve_artifact_root(artifact_root);
    expect(resolve_artifact_path(root_context, "..cache/report.png")).toBe(join(artifact_root, "..cache/report.png"));
  } finally {
    rmSync(artifact_root, { recursive: true, force: true });
  }
});

test("resolve_artifact_root normalizes non-directory stat failures", () => {
  const artifact_root = mkdtempSync(join(tmpdir(), "local-mcp-file-artifact-root-"));
  const file_path = join(artifact_root, "not-a-directory");

  try {
    writeFileSync(file_path, "");
    expect(() => resolve_artifact_root(file_path)).toThrow(`artifact root must be an existing directory: ${file_path}`);
  } finally {
    rmSync(artifact_root, { recursive: true, force: true });
  }
});

test("prepare_artifact_destination returns a tool error when the artifact root is deleted", () => {
  const artifact_root = mkdtempSync(join(tmpdir(), "local-mcp-deleted-artifact-root-"));
  const root_context = resolve_artifact_root(artifact_root);
  const absolute_path = resolve_artifact_path(root_context, "capture.png");

  rmSync(artifact_root, { recursive: true, force: true });

  try {
    prepare_artifact_destination(root_context, absolute_path, "capture.png");
    throw new Error("expected deleted artifact root validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(tool_error);
    expect((error as tool_error).code).toBe("INVALID_ARGUMENT");
    expect((error as tool_error).message).toContain("artifact parent path must be a directory");
  } finally {
    rmSync(artifact_root, { recursive: true, force: true });
  }
});

symlink_test("write_artifact_file rejects destination symlinks", async () => {
  const artifact_root = mkdtempSync(join(tmpdir(), "local-mcp-symlink-target-root-"));
  const outside_root = mkdtempSync(join(tmpdir(), "local-mcp-symlink-target-outside-"));
  const outside_file = join(outside_root, "target.png");
  const link_path = join(artifact_root, "capture.png");

  try {
    writeFileSync(outside_file, "original");
    symlinkSync(outside_file, link_path, "file");
    const root_context = resolve_artifact_root(artifact_root);

    try {
      await write_artifact_file(root_context, link_path, "capture.png", new Uint8Array([1, 2, 3]));
      throw new Error("expected destination symlink validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(tool_error);
      expect((error as tool_error).code).toBe("INVALID_ARGUMENT");
      expect((error as tool_error).message).toContain("artifact path cannot target a symbolic link");
      expect(readFileSync(outside_file, "utf8")).toBe("original");
    }
  } finally {
    rmSync(artifact_root, { recursive: true, force: true });
    rmSync(outside_root, { recursive: true, force: true });
  }
});

symlink_test("write_artifact_file rejects symlink parents before nested directory creation", async () => {
  const artifact_root = mkdtempSync(join(tmpdir(), "local-mcp-symlink-parent-root-"));
  const outside_root = mkdtempSync(join(tmpdir(), "local-mcp-symlink-parent-outside-"));
  const link_path = join(artifact_root, "nested");
  const outside_child = join(outside_root, "child");

  try {
    symlinkSync(outside_root, link_path, "dir");
    const root_context = resolve_artifact_root(artifact_root);
    const artifact_path = join(link_path, "child", "capture.png");

    try {
      await write_artifact_file(root_context, artifact_path, "nested/child/capture.png", new Uint8Array([1, 2, 3]));
      throw new Error("expected parent symlink validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(tool_error);
      expect((error as tool_error).code).toBe("INVALID_ARGUMENT");
      expect((error as tool_error).message).toContain("artifact path cannot traverse a symbolic link");
      expect(existsSync(outside_child)).toBe(false);
    }
  } finally {
    rmSync(artifact_root, { recursive: true, force: true });
    rmSync(outside_root, { recursive: true, force: true });
  }
});

symlink_test("write_artifact_file allows nested artifacts under a symlinked root", async () => {
  const artifact_root_target = mkdtempSync(join(tmpdir(), "local-mcp-symlink-root-target-"));
  const link_parent = mkdtempSync(join(tmpdir(), "local-mcp-symlink-root-parent-"));
  const artifact_root_link = join(link_parent, "workspace");
  const artifact_path = join(artifact_root_link, "captures", "capture.png");
  const target_path = join(artifact_root_target, "captures", "capture.png");

  try {
    symlinkSync(artifact_root_target, artifact_root_link, "dir");
    const root_context = resolve_artifact_root(artifact_root_link);

    await write_artifact_file(root_context, artifact_path, "captures/capture.png", new Uint8Array([1, 2, 3]));

    expect(Array.from(readFileSync(target_path))).toEqual([1, 2, 3]);
  } finally {
    rmSync(link_parent, { recursive: true, force: true });
    rmSync(artifact_root_target, { recursive: true, force: true });
  }
});

test("write_artifact_file rejects directory targets", async () => {
  const artifact_root = mkdtempSync(join(tmpdir(), "local-mcp-directory-target-root-"));
  const directory_target = join(artifact_root, "capture.png");

  try {
    mkdirSync(directory_target);
    const root_context = resolve_artifact_root(artifact_root);

    try {
      await write_artifact_file(root_context, directory_target, "capture.png", new Uint8Array([1, 2, 3]));
      throw new Error("expected directory target validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(tool_error);
      expect((error as tool_error).code).toBe("INVALID_ARGUMENT");
      expect((error as tool_error).message).toContain("artifact path cannot target a directory");
    }
  } finally {
    rmSync(artifact_root, { recursive: true, force: true });
  }
});

test("write_artifact_file replaces regular destinations through final rename", async () => {
  const artifact_root = mkdtempSync(join(tmpdir(), "local-mcp-overwrite-root-"));
  const output_path = join(artifact_root, "capture.png");

  try {
    writeFileSync(output_path, "old");
    const root_context = resolve_artifact_root(artifact_root);

    await write_artifact_file(root_context, output_path, "capture.png", new Uint8Array([1, 2, 3]));

    expect(Array.from(readFileSync(output_path))).toEqual([1, 2, 3]);
  } finally {
    rmSync(artifact_root, { recursive: true, force: true });
  }
});
