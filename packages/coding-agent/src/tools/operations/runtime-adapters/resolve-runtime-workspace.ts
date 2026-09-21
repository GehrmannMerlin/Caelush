import type { ToolExecutionEnvironment } from "@caelush/agent";
import {
  RuntimeUnsupportedError,
  type RuntimeResolver,
  type RuntimeWorkspaceScope,
} from "@caelush/runtime";
/**
 * The shared Runtime scope resolution for every Operations adapter.
 *
 * ```text
 * environment.runtime    → RuntimeResolver.resolve()
 * environment.workspace  → runtime.openWorkspace()
 * ```
 *
 * Every adapter needs exactly this, and eight copies of it would be eight places for the unsupported
 * runtime rule to drift. It lives here, in `operations/runtime-adapters/`, which is the **only**
 * directory in `@caelush/coding-agent` permitted to import the broad Runtime types. A Coding builtin
 * imports none of them: it receives a `ToolExecutionEnvironment` locator and a narrow Operations port.
 *
 * ## Why the scope never escapes this directory
 *
 * `RuntimeWorkspaceScope` is a capability bundle — filesystem, discovery, search, patch, exec, git. A
 * Tool holding one could do anything the Runtime can do, whatever its declared capabilities say. So the
 * scope is resolved here, used inside one adapter method, and dropped: what crosses back out is a
 * narrow business result.
 *
 * ## Unsupported runtime
 *
 * A locator naming a runtime this host has not registered raises `RuntimeUnsupportedError` — the
 * Runtime's own error, with the Runtime's own `UNSUPPORTED_RUNTIME` code. The adapters do not invent a
 * private signal for it; the Coding Tool layer maps that code onto a safe model-facing result, exactly
 * as the legacy builtins did, so the migration does not change what the model is told.
 */
export function resolveRuntimeWorkspace(
  resolver: RuntimeResolver,
  environment: ToolExecutionEnvironment,
): Promise<RuntimeWorkspaceScope> {
  const runtime = resolver.resolve(environment.runtime);
  if (runtime === undefined) throw new RuntimeUnsupportedError();
  return runtime.openWorkspace(environment.workspace);
}
