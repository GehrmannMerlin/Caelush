import type { EnvironmentSnapshot } from "./environment.js";
import type { ProjectInstructions } from "./instructions.js";
import type { ProjectProfile, ContextDiagnostic } from "./project-profile.js";
import type { ProjectRootDetectionResult } from "./project-root.js";
import type { WorkspaceScope } from "./workspace.js";

export interface ProjectIntelligenceSnapshot {
  readonly workspace: WorkspaceScope;
  readonly projectRoot: ProjectRootDetectionResult;
  readonly environment: EnvironmentSnapshot;
  readonly profile: ProjectProfile;
  readonly instructions: ProjectInstructions;
  readonly diagnostics: readonly ContextDiagnostic[];
}
