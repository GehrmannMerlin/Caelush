import type { WorkspaceRef } from "@caelush/protocol";
import { LocalEnvironmentDetector, type EnvironmentDetector } from "./environment.js";
import { LocalContextFileSystem, type ContextFileSystem } from "./filesystem.js";
import {
  ProjectInstructionDiscovery,
  type ProjectInstructionDiscoveryOptions,
} from "./instructions.js";
import { ProjectProfileDetector } from "./project-profile.js";
import { ProjectRootDetector } from "./project-root.js";
import type { ProjectIntelligenceSnapshot } from "./snapshot.js";
import { WorkspaceScopeResolver } from "./workspace.js";

export interface ProjectInspectorInput {
  readonly workspace: WorkspaceRef;
  readonly cwd?: string;
}

export interface ProjectInspectorDependencies {
  readonly filesystem: ContextFileSystem;
  readonly environmentDetector?: EnvironmentDetector;
  readonly projectRootDetector?: ProjectRootDetector;
  readonly profileDetector?: ProjectProfileDetector;
  readonly instructionDiscovery?: ProjectInstructionDiscovery;
  readonly instructionOptions?: ProjectInstructionDiscoveryOptions;
}

export class ProjectInspector {
  private readonly scopeResolver: WorkspaceScopeResolver;
  private readonly environmentDetector: EnvironmentDetector;
  private readonly projectRootDetector: ProjectRootDetector;
  private readonly profileDetector: ProjectProfileDetector;
  private readonly instructionDiscovery: ProjectInstructionDiscovery;

  constructor(private readonly dependencies: ProjectInspectorDependencies) {
    this.scopeResolver = new WorkspaceScopeResolver(dependencies.filesystem);
    this.environmentDetector = dependencies.environmentDetector ?? new LocalEnvironmentDetector();
    this.projectRootDetector =
      dependencies.projectRootDetector ?? new ProjectRootDetector(dependencies.filesystem);
    this.profileDetector =
      dependencies.profileDetector ?? new ProjectProfileDetector(dependencies.filesystem);
    this.instructionDiscovery =
      dependencies.instructionDiscovery ?? new ProjectInstructionDiscovery(dependencies.filesystem);
  }

  async inspect(input: ProjectInspectorInput): Promise<ProjectIntelligenceSnapshot> {
    const workspace = await this.scopeResolver.resolve(input.workspace, input.cwd);
    const projectRoot = await this.projectRootDetector.detect(workspace);
    const environment = this.environmentDetector.detect(workspace, projectRoot.projectRoot);
    const profileResult = await this.profileDetector.detect(workspace, projectRoot.projectRoot);
    const instructions = await this.instructionDiscovery.discover(
      workspace,
      projectRoot.projectRoot,
      workspace.realCwd,
      this.dependencies.instructionOptions,
    );
    return {
      workspace,
      projectRoot,
      environment,
      profile: profileResult.profile,
      instructions,
      diagnostics: profileResult.diagnostics,
    };
  }
}

export function createLocalProjectInspector(
  options: Omit<ProjectInspectorDependencies, "filesystem"> = {},
): ProjectInspector {
  return new ProjectInspector({ filesystem: new LocalContextFileSystem(), ...options });
}
