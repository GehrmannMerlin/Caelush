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
