import { RuntimeRefSchema, WorkspaceRefSchema } from "@caelush/protocol";
import type { RuntimeRef, WorkspaceRef } from "@caelush/protocol";

/**
 * Where a Tool executes, as data.
 *
 * ```text
 * workspace  the Workspace the Run is scoped to
 * runtime    the Runtime selection the Run declared
 * ```
 *
 * This is the Agent Tool Layer's own declaration of the **compatibility execution locator**. It is
 * structurally identical to the durable `ToolExecutionEnvironment` the Protocol freezes, and that is
 * deliberate: the value crosses the durable boundary, so the general contract may not invent a
 * second shape for it.
 *
 * It is *not* a capability object. A Tool that receives this value learns where it runs; it must not
 * be able to open a file or start a process from it. Environment capabilities reach a Tool through
 * narrow Operations interfaces, never through this locator.
 */
export interface ToolExecutionEnvironment {
  readonly workspace: WorkspaceRef;
  readonly runtime: RuntimeRef;
}

/**
 * Whether a value is a well-formed execution locator.
 *
 * The two fields are validated against the Protocol schemas they are structurally identical to, rather
 * than against a private shape: a locator that drifted from the durable contract would make a batch
 * request describe an environment the invocation could not be persisted against.
 *
 * The declaration lives here, with the vocabulary, so a caller that only *carries* an environment — the
 * Tool batch request validator, for instance — does not have to name a workspace or a runtime itself.
 */
export function isToolExecutionEnvironment(value: unknown): value is ToolExecutionEnvironment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const environment = value as Record<string, unknown>;
  return (
    Object.keys(environment).length === 2 &&
    Object.hasOwn(environment, "workspace") &&
    Object.hasOwn(environment, "runtime") &&
    WorkspaceRefSchema.safeParse(environment.workspace).success &&
    RuntimeRefSchema.safeParse(environment.runtime).success
  );
}
