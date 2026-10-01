import type { ToolExecutionEnvironment, ToolSecurityContext } from "@caelush/agent";
import {
  createAuthorizedRuntimeExecution,
  createRuntimeFilesystemPolicy,
  createRuntimeProcessPolicy,
  createUnrestrictedProcessSandboxProvider,
  RuntimeUnsupportedError,
  type AuthorizedRuntimeExecution,
  type RuntimeResolver,
  type RuntimeWorkspaceOpenOptions,
  type RuntimeWorkspaceScope,
} from "@caelush/runtime";
import type { RunId } from "@caelush/protocol";
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
  options: RuntimeWorkspaceResolutionOptions = {},
): Promise<RuntimeWorkspaceScope> {
  const runtime = resolver.resolve(environment.runtime);
  if (runtime === undefined) throw new RuntimeUnsupportedError();
  const openOptions = openOptionsFor(environment, options);
  return runtime.openWorkspace(environment.workspace, openOptions);
}

export interface RuntimeWorkspaceResolutionOptions {
  readonly securityContext?: ToolSecurityContext | undefined;
  readonly processAuthorization?: AuthorizedRuntimeExecution | undefined;
}

/**
 * Create the Runtime's path policy from the path-free Run reference.
 *
 * The product policy is authoritative for the boundary, while the workspace locator supplies the
 * host-local root. No absolute host path is accepted from the model or persisted policy snapshot.
 */
function openOptionsFor(
  environment: ToolExecutionEnvironment,
  options: RuntimeWorkspaceResolutionOptions,
): RuntimeWorkspaceOpenOptions {
  const reference = options.securityContext?.securityPolicy;
  const filesystemPolicy =
    reference === undefined
      ? undefined
      : createRuntimeFilesystemPolicy({
          workspaceId: environment.workspace.id,
          workspaceRoot: environment.workspace.path,
          boundary: reference.filesystemBoundary,
          protectedRoots: [],
        });
  return {
    ...(filesystemPolicy === undefined ? {} : { filesystemPolicy }),
    ...(options.processAuthorization === undefined
      ? {}
      : { processAuthorization: options.processAuthorization }),
  };
}

/**
 * The explicit Full Access process path used until the daemon capability service supplies a probed
 * platform Provider. Restricted policies intentionally return no authorization here: LocalRuntime is
 * configured to reject an unbound process rather than falling back to ordinary spawn.
 */
export function createDefaultRuntimeProcessAuthorization(input: {
  readonly ownerRunId: RunId;
  readonly environment: ToolExecutionEnvironment;
  readonly securityContext?: ToolSecurityContext | undefined;
}): AuthorizedRuntimeExecution | undefined {
  const reference = input.securityContext?.securityPolicy;
  if (reference === undefined || reference.processBoundary !== "UNRESTRICTED") return undefined;
  const policy = createRuntimeProcessPolicy({
    runId: input.ownerRunId,
    workspaceId: input.environment.workspace.id,
    workspaceRoot: input.environment.workspace.path,
    filesystemBoundary: reference.filesystemBoundary,
    processBoundary: reference.processBoundary,
    requiredEnforcement: reference.requiredEnforcement,
  });
  return createAuthorizedRuntimeExecution({
    policy,
    provider: createUnrestrictedProcessSandboxProvider(),
    authorizationNonce: `${input.ownerRunId}:${reference.policyDigest}:full`,
  });
}
