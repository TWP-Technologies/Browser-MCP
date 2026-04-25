// Modified by [KnotFalse]
import { randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { tool_error } from "./errors";

export interface artifact_root_context {
  artifact_root: string;
  artifact_root_real: string;
}

export type artifact_root_context_input = artifact_root_context | (() => artifact_root_context);

const artifact_temp_file_write_flags =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
const artifact_parent_directory_open_flags = constants.O_RDONLY | constants.O_DIRECTORY;

export function is_within_root(root_path: string, candidate_path: string): boolean {
  const relative_path = relative(root_path, candidate_path);
  return relative_path === "" || (!/^\.\.(?:[\\/]|$)/.test(relative_path) && !isAbsolute(relative_path));
}

export function resolve_artifact_root(root_path = process.cwd()): artifact_root_context {
  const artifact_root = resolve(root_path);
  let artifact_root_real: string;
  try {
    artifact_root_real = realpathSync(artifact_root);
  } catch {
    throw new Error(`artifact root must be an existing directory: ${artifact_root}`);
  }

  try {
    if (!statSync(artifact_root_real).isDirectory()) {
      throw new Error(`artifact root must be an existing directory: ${artifact_root}`);
    }
  } catch {
    throw new Error(`artifact root must be an existing directory: ${artifact_root}`);
  }

  return {
    artifact_root,
    artifact_root_real,
  };
}

export function resolve_default_artifact_root(): artifact_root_context {
  try {
    return resolve_artifact_root();
  } catch {
    return resolve_artifact_root(tmpdir());
  }
}

export function resolve_artifact_path(root_context: artifact_root_context, requested_path: string): string {
  const candidate_path = isAbsolute(requested_path)
    ? resolve(requested_path)
    : resolve(root_context.artifact_root, requested_path);

  if (!is_within_root(root_context.artifact_root, candidate_path)) {
    throw new tool_error("INVALID_ARGUMENT", "artifact path must stay within the current workspace", false, {
      path: requested_path,
      artifact_root: root_context.artifact_root,
    });
  }

  return candidate_path;
}

export function resolve_artifact_root_context_input(root_context: artifact_root_context_input): artifact_root_context {
  return typeof root_context === "function" ? root_context() : root_context;
}

export function clone_artifact_root_context(root_context: artifact_root_context): artifact_root_context {
  return {
    artifact_root: root_context.artifact_root,
    artifact_root_real: root_context.artifact_root_real,
  };
}

export function clone_artifact_root_context_input(
  root_context: artifact_root_context_input,
): artifact_root_context_input {
  return typeof root_context === "function" ? root_context : clone_artifact_root_context(root_context);
}

function throw_artifact_boundary_error(root_context: artifact_root_context, requested_path: string): never {
  throw new tool_error("INVALID_ARGUMENT", "artifact path must stay within the current workspace", false, {
    path: requested_path,
    artifact_root: root_context.artifact_root,
  });
}

function get_error_code(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const error_code = (error as { code?: unknown }).code;
  return typeof error_code === "string" ? error_code : undefined;
}

function throw_artifact_symlink_error(root_context: artifact_root_context, requested_path: string): never {
  throw new tool_error("INVALID_ARGUMENT", "artifact path cannot traverse a symbolic link", false, {
    path: requested_path,
    artifact_root: root_context.artifact_root,
  });
}

function throw_artifact_parent_error(root_context: artifact_root_context, requested_path: string): never {
  throw new tool_error("INVALID_ARGUMENT", "artifact parent path must be a directory", false, {
    path: requested_path,
    artifact_root: root_context.artifact_root,
  });
}

function validate_artifact_root_directory(root_context: artifact_root_context, requested_path: string): void {
  let root_stat: ReturnType<typeof statSync>;
  try {
    root_stat = statSync(root_context.artifact_root);
  } catch {
    throw_artifact_parent_error(root_context, requested_path);
  }

  if (!root_stat.isDirectory()) {
    throw_artifact_parent_error(root_context, requested_path);
  }

  let root_real: string;
  try {
    root_real = realpathSync(root_context.artifact_root);
  } catch {
    throw_artifact_parent_error(root_context, requested_path);
  }

  if (root_real !== root_context.artifact_root_real) {
    throw_artifact_boundary_error(root_context, requested_path);
  }
}

function validate_artifact_parent_segment(
  root_context: artifact_root_context,
  directory_path: string,
  requested_path: string,
): void {
  let directory_lstat: ReturnType<typeof lstatSync>;
  try {
    directory_lstat = lstatSync(directory_path);
  } catch {
    throw_artifact_parent_error(root_context, requested_path);
  }

  if (directory_lstat.isSymbolicLink()) {
    throw_artifact_symlink_error(root_context, requested_path);
  }

  if (!directory_lstat.isDirectory()) {
    throw_artifact_parent_error(root_context, requested_path);
  }

  let directory_real: string;
  try {
    directory_real = realpathSync(directory_path);
  } catch {
    throw_artifact_parent_error(root_context, requested_path);
  }

  if (!is_within_root(root_context.artifact_root_real, directory_real)) {
    throw_artifact_boundary_error(root_context, requested_path);
  }
}

function validate_artifact_parent_before_creation(
  root_context: artifact_root_context,
  parent_path: string,
  requested_path: string,
): void {
  if (relative(root_context.artifact_root, parent_path) === "") {
    validate_artifact_root_directory(root_context, requested_path);
    return;
  }

  validate_artifact_parent_segment(root_context, parent_path, requested_path);
}

function prepare_artifact_parent_directory(
  root_context: artifact_root_context,
  parent_path: string,
  requested_path: string,
): void {
  if (!is_within_root(root_context.artifact_root, parent_path)) {
    throw_artifact_boundary_error(root_context, requested_path);
  }

  const relative_parent_path = relative(root_context.artifact_root, parent_path);
  const path_segments = relative_parent_path === "" ? [] : relative_parent_path.split(/[\\/]+/);
  let current_path = root_context.artifact_root;
  validate_artifact_root_directory(root_context, requested_path);

  for (const path_segment of path_segments) {
    current_path = resolve(current_path, path_segment);

    if (!existsSync(current_path)) {
      validate_artifact_parent_before_creation(root_context, dirname(current_path), requested_path);
      try {
        mkdirSync(current_path);
      } catch (error) {
        if (get_error_code(error) !== "EEXIST") {
          throw error;
        }
      }
    }

    validate_artifact_parent_segment(root_context, current_path, requested_path);
  }
}

export function prepare_artifact_destination(
  root_context: artifact_root_context,
  absolute_path: string,
  requested_path: string,
): void {
  prepare_artifact_parent_directory(root_context, dirname(absolute_path), requested_path);

  if (existsSync(absolute_path)) {
    try {
      const destination_lstat = lstatSync(absolute_path);
      if (destination_lstat.isSymbolicLink()) {
        throw new tool_error("INVALID_ARGUMENT", "artifact path cannot target a symbolic link", false, {
          path: requested_path,
          artifact_root: root_context.artifact_root,
        });
      }

      if (destination_lstat.isDirectory()) {
        throw new tool_error("INVALID_ARGUMENT", "artifact path cannot target a directory", false, {
          path: requested_path,
          artifact_root: root_context.artifact_root,
        });
      }
    } catch (error) {
      if (error instanceof tool_error) {
        throw error;
      }

      if (get_error_code(error) !== "ENOENT") {
        throw error;
      }
    }
  }
}

function build_artifact_temp_name(absolute_path: string): string {
  const destination_name = basename(absolute_path);
  return `.${destination_name}.${process.pid}.${randomUUID()}.tmp`;
}

async function open_stable_parent_directory(parent_path: string): Promise<FileHandle | undefined> {
  if (process.platform !== "linux") {
    // macOS has openat/renameat syscalls, but Node/libuv do not expose fd-relative wrappers.
    // Non-Linux writes rely on repeated destination validation plus no-follow final file opens.
    return undefined;
  }

  return await open(parent_path, artifact_parent_directory_open_flags);
}

function get_stable_parent_path(parent_directory_handle: FileHandle | undefined, parent_path: string): string {
  if (!parent_directory_handle) {
    return parent_path;
  }

  // Node does not expose renameat; Linux proc fd paths keep source and target relative to the opened directory.
  return `/proc/self/fd/${parent_directory_handle.fd}`;
}

function validate_written_artifact_file(
  root_context: artifact_root_context,
  absolute_path: string,
  anchored_path: string,
  requested_path: string,
): void {
  prepare_artifact_destination(root_context, absolute_path, requested_path);

  let absolute_real: string;
  let anchored_real: string;
  try {
    absolute_real = realpathSync(absolute_path);
    anchored_real = realpathSync(anchored_path);
  } catch {
    throw_artifact_boundary_error(root_context, requested_path);
  }

  if (absolute_real !== anchored_real || !is_within_root(root_context.artifact_root_real, anchored_real)) {
    throw_artifact_boundary_error(root_context, requested_path);
  }
}

export async function write_artifact_file(
  root_context: artifact_root_context,
  absolute_path: string,
  requested_path: string,
  bytes: Uint8Array,
): Promise<void> {
  prepare_artifact_destination(root_context, absolute_path, requested_path);
  const parent_path = dirname(absolute_path);
  const destination_name = basename(absolute_path);
  const temp_name = build_artifact_temp_name(absolute_path);
  let parent_directory_handle: FileHandle | undefined;
  let temp_cleanup_path: string | undefined;
  let final_cleanup_path: string | undefined;

  try {
    parent_directory_handle = await open_stable_parent_directory(parent_path);
    const stable_parent_path = get_stable_parent_path(parent_directory_handle, parent_path);
    const temp_path = resolve(stable_parent_path, temp_name);
    const final_path = resolve(stable_parent_path, destination_name);
    temp_cleanup_path = temp_path;

    const file_handle = await open(temp_path, artifact_temp_file_write_flags, 0o600);
    try {
      // Keep the writable handle off the caller-requested final pathname; final placement is a rename.
      prepare_artifact_destination(root_context, absolute_path, requested_path);
      await file_handle.writeFile(bytes);
    } finally {
      await file_handle.close();
    }

    prepare_artifact_destination(root_context, absolute_path, requested_path);
    renameSync(temp_path, final_path);
    temp_cleanup_path = undefined;
    final_cleanup_path = final_path;
    validate_written_artifact_file(root_context, absolute_path, final_path, requested_path);
    final_cleanup_path = undefined;
  } catch (error) {
    if (final_cleanup_path) {
      rmSync(final_cleanup_path, { force: true });
    }

    if (temp_cleanup_path) {
      rmSync(temp_cleanup_path, { force: true });
    }

    if (get_error_code(error) === "ELOOP") {
      throw new tool_error("INVALID_ARGUMENT", "artifact path cannot target a symbolic link", false, {
        path: requested_path,
        artifact_root: root_context.artifact_root,
      });
    }

    throw error;
  } finally {
    if (parent_directory_handle) {
      await parent_directory_handle.close();
    }
  }
}
