import type { RuntimeRef, WorkspaceRef } from "@caelush/protocol";
import type { RuntimeWorkspaceScope } from "./workspace-scope.js";

export interface Runtime {
  readonly kind: string;
  supports(ref: RuntimeRef): boolean;
  openWorkspace(workspace: WorkspaceRef): Promise<RuntimeWorkspaceScope>;
}
