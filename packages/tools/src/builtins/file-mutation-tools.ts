import { LocalRuntime, createLocalRuntimeResolver, type RuntimeResolver } from "@caelush/runtime";
import type { ToolRegistration } from "../registration.js";
import { createApplyPatchRegistration } from "./apply-patch.js";

export function createFileMutationToolRegistrations(
  runtimeResolver: RuntimeResolver = createLocalRuntimeResolver(new LocalRuntime()),
): readonly ToolRegistration[] {
  return [createApplyPatchRegistration(runtimeResolver)];
}
