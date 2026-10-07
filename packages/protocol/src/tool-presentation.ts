import { z } from "zod";
import { FileChangeTypeSchema } from "./file.js";
import { ToolInvocationStatusSchema } from "./tool.js";

/** Stable UI grouping hints; these never participate in Tool admission or execution. */
export const ToolPresentationCategorySchema = z.enum([
  "READ",
  "SEARCH",
  "EDIT",
  "COMMAND",
  "PROCESS",
  "GIT",
  "OTHER",
]);
export type ToolPresentationCategory = z.infer<typeof ToolPresentationCategorySchema>;

/** Presentation lifecycle mirrors durable invocation facts without changing their authority. */
export const ToolPresentationPhaseSchema = ToolInvocationStatusSchema;
export type ToolPresentationPhase = z.infer<typeof ToolPresentationPhaseSchema>;

const SafeWorkspacePresentationPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes("\\") &&
      !path.split("/").some((segment) => segment.length === 0 || segment === ".."),
    "expected a normalized workspace-relative presentation path",
  );

/** Safe, structured file metadata. Patch bodies and file contents are intentionally absent. */
export const ToolFileChangeEffectSchema = z
  .object({
    type: z.literal("FILE_CHANGE"),
    path: SafeWorkspacePresentationPathSchema,
    changeType: FileChangeTypeSchema,
    fromPath: SafeWorkspacePresentationPathSchema.optional(),
    additions: z.number().int().nonnegative().safe().optional(),
    deletions: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
export type ToolFileChangeEffect = z.infer<typeof ToolFileChangeEffectSchema>;

export const ToolPresentationEffectSchema = z.discriminatedUnion("type", [
  ToolFileChangeEffectSchema,
]);
export type ToolPresentationEffect = z.infer<typeof ToolPresentationEffectSchema>;

/** Known built-in Tool names get a stable UI category; future/host Tools default to OTHER. */
export function toolPresentationCategory(toolName: string): ToolPresentationCategory {
  switch (toolName) {
    case "read_file":
      return "READ";
    case "list_directory":
    case "find_files":
    case "search_text":
      return "SEARCH";
    case "apply_patch":
      return "EDIT";
    case "exec_command":
      return "COMMAND";
    case "write_stdin":
    case "stop_process":
      return "PROCESS";
    case "git_status":
    case "git_diff":
      return "GIT";
    default:
      return "OTHER";
  }
}
