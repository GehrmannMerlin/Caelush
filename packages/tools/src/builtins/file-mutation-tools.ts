import type { RuntimeResolver } from "@caelush/runtime";
import type { ToolRegistration } from "../registration.js";
import { createApplyPatchRegistration } from "./apply-patch.js";

export function createFileMutationToolRegistrations(
  runtimeResolver: RuntimeResolver,
): readonly ToolRegistration[] {
  return [createApplyPatchRegistration(runtimeResolver)];
}
