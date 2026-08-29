import { LocalRuntime, createLocalRuntimeResolver, type RuntimeResolver } from "@caelush/runtime";
import type { ToolRegistration } from "../registration.js";
import { createExecCommandRegistration } from "./exec-command.js";
import { createWriteStdinRegistration } from "./write-stdin.js";

export function createShellToolRegistrations(
  runtimeResolver: RuntimeResolver = createLocalRuntimeResolver(new LocalRuntime()),
): readonly ToolRegistration[] {
  return [
    createExecCommandRegistration(runtimeResolver),
    createWriteStdinRegistration(runtimeResolver),
  ];
}
