import type { RuntimeResolver } from "@caelush/runtime";
import type { ToolRegistration } from "../registration.js";
import { createGitDiffRegistration } from "./git-diff.js";
import { createGitStatusRegistration } from "./git-status.js";

export function createGitToolRegistrations(
  runtimeResolver: RuntimeResolver,
): readonly ToolRegistration[] {
  return [createGitStatusRegistration(runtimeResolver), createGitDiffRegistration(runtimeResolver)];
}
