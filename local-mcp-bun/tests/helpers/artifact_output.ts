import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

export function create_workspace_output_dir(prefix: string): string {
  return mkdtempSync(join(resolve(process.cwd()), `.tmp-artifacts-${prefix}`));
}
