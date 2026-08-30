import type { RuntimeResolver } from "@caelush/runtime";
import type { ToolRegistration } from "../registration.js";
import { createFileMutationToolRegistrations } from "./file-mutation-tools.js";
import { createGitToolRegistrations } from "./git-tools.js";
import { createReadOnlyFilesystemToolRegistrations } from "./read-only-filesystem-tools.js";
import { createShellToolRegistrations } from "./shell-tools.js";

export const DEFAULT_BUILTIN_TOOL_ORDER = Object.freeze([
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "git_status",
  "git_diff",
] as const);

export function createDefaultBuiltinToolRegistrations(
  runtimeResolver: RuntimeResolver,
): readonly ToolRegistration[] {
  return Object.freeze([
    ...createReadOnlyFilesystemToolRegistrations(runtimeResolver),
    ...createFileMutationToolRegistrations(runtimeResolver),
    ...createShellToolRegistrations(runtimeResolver),
    ...createGitToolRegistrations(runtimeResolver),
  ]);
}
