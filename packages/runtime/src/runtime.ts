import type { RuntimeRef, WorkspaceRef } from "@caelush/protocol";
import type {
  AuthorizedRuntimeExecution,
  RuntimeFilesystemPolicy,
} from "./security/runtime-boundary.js";
import type { RuntimeWorkspaceScope } from "./workspace-scope.js";

export interface RuntimeWorkspaceOpenOptions {
  readonly filesystemPolicy?: RuntimeFilesystemPolicy;
  readonly processAuthorization?: AuthorizedRuntimeExecution;
}

export interface Runtime {
  readonly kind: string;
  supports(ref: RuntimeRef): boolean;
  openWorkspace(
    workspace: WorkspaceRef,
    options?: RuntimeWorkspaceOpenOptions,
  ): Promise<RuntimeWorkspaceScope>;
}
