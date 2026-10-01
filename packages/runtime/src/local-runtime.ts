import path from "node:path";
import { WorkspaceRefSchema, type RuntimeRef, type WorkspaceRef } from "@caelush/protocol";
import { LocalRuntimeFileDiscovery } from "./discovery/file-discovery.js";
import type { RuntimeFileDiscovery } from "./discovery/file-discovery.js";
import { LocalRuntimeFileSystem } from "./filesystem/local-filesystem.js";
import {
  PolicyAwareRuntimeFileSystem,
  createPolicyAwarePatchMutationFileSystem,
} from "./filesystem/policy-aware-filesystem.js";
import type { RuntimeFileSystem } from "./filesystem/types.js";
import { LocalRipgrepRunner } from "./search/ripgrep-runner.js";
import type { RuntimeTextSearch } from "./search/text-search.js";
import { RuntimeWorkspaceError } from "./runtime-errors.js";
import { LOCAL_RUNTIME_KIND } from "./runtime-ref.js";
import type { Runtime } from "./runtime.js";
import { WorkspacePathResolver } from "./workspace-path.js";
import { createLocalPatchMutationFileSystem } from "./patch/committer.js";
import { createRuntimePatchService } from "./patch/service.js";
import type { RuntimeWorkspaceScope } from "./workspace-scope.js";
import { createRuntimeFilesystemPolicy } from "./security/runtime-boundary.js";
import type { RuntimeWorkspaceOpenOptions } from "./runtime.js";
import { LocalProcessManager, type LocalProcessManagerOptions } from "./exec/process-manager.js";
import { LocalRuntimeExecService } from "./exec/service.js";
import { LocalShellResolver, type LocalShellResolverOptions } from "./exec/shell-resolver.js";
import { LocalGitService } from "./git/service.js";
import type { RuntimeGitService } from "./git/contracts.js";

export interface LocalRuntimeOptions {
  readonly filesystem?: RuntimeFileSystem;
  readonly discovery?: RuntimeFileDiscovery;
  readonly textSearch?: RuntimeTextSearch;
  readonly processManager?: LocalProcessManager;
  readonly processManagerOptions?: LocalProcessManagerOptions;
  readonly shellResolver?: LocalShellResolver;
  readonly shellResolverOptions?: LocalShellResolverOptions;
  readonly git?: RuntimeGitService;
}

export class LocalRuntime implements Runtime {
  readonly kind = LOCAL_RUNTIME_KIND;
  private readonly filesystem: RuntimeFileSystem;
  private readonly discovery: RuntimeFileDiscovery;
  private readonly textSearch: RuntimeTextSearch;
  private readonly processManager: LocalProcessManager;
  private readonly shellResolver: LocalShellResolver;
  private readonly git: RuntimeGitService | undefined;

  constructor(options: LocalRuntimeOptions = {}) {
    this.filesystem = options.filesystem ?? new LocalRuntimeFileSystem();
    this.discovery = options.discovery ?? new LocalRuntimeFileDiscovery();
    this.textSearch = options.textSearch ?? new LocalRipgrepRunner();
    this.processManager =
      options.processManager ?? new LocalProcessManager(options.processManagerOptions);
    this.shellResolver =
      options.shellResolver ?? new LocalShellResolver(options.shellResolverOptions);
    this.git = options.git;
  }

  supports(ref: RuntimeRef): boolean {
    return ref.kind === this.kind;
  }

  async openWorkspace(
    workspace: WorkspaceRef,
    options: RuntimeWorkspaceOpenOptions = {},
  ): Promise<RuntimeWorkspaceScope> {
    const parsed = WorkspaceRefSchema.safeParse(workspace);
    if (!parsed.success || !path.isAbsolute(workspace.path)) {
      throw new RuntimeWorkspaceError("workspace path must be absolute");
    }
    const logicalRoot = path.normalize(workspace.path);
    let metadata;
    try {
      metadata = await this.filesystem.getMetadata(logicalRoot);
    } catch (error) {
      throw new RuntimeWorkspaceError("workspace could not be inspected", { cause: error });
    }
    if (metadata === null) throw new RuntimeWorkspaceError("workspace does not exist");
    let realRoot: string;
    try {
      realRoot = path.normalize(await this.filesystem.realpath(logicalRoot));
    } catch (error) {
      throw new RuntimeWorkspaceError("workspace could not be resolved", { cause: error });
    }
    const realMetadata = await this.filesystem.getMetadata(realRoot);
    if (realMetadata?.kind !== "DIRECTORY") {
      throw new RuntimeWorkspaceError("workspace is not a directory");
    }
    const filesystemPolicy =
      options.filesystemPolicy ??
      options.processAuthorization?.policy.filesystem ??
      createRuntimeFilesystemPolicy({
        workspaceId: parsed.data.id,
        workspaceRoot: logicalRoot,
        boundary: "WORKSPACE_READ_WRITE",
        protectedRoots: [],
      });
    if (
      filesystemPolicy.workspaceId !== parsed.data.id ||
      path.normalize(filesystemPolicy.workspaceRoot) !== logicalRoot
    ) {
      throw new RuntimeWorkspaceError("filesystem policy does not match the workspace");
    }
    if (
      options.processAuthorization !== undefined &&
      (options.processAuthorization.policy.filesystem.workspaceId !==
        filesystemPolicy.workspaceId ||
        path.normalize(options.processAuthorization.policy.filesystem.workspaceRoot) !==
          logicalRoot)
    ) {
      throw new RuntimeWorkspaceError("process authorization does not match the workspace");
    }
    const scope = {
      workspace: parsed.data,
      logicalRoot,
      realRoot,
      filesystem: this.filesystem,
      policy: filesystemPolicy,
    } as const;
    const pathResolver = new WorkspacePathResolver(scope);
    const policyAwareFilesystem = new PolicyAwareRuntimeFileSystem(
      this.filesystem,
      pathResolver,
      filesystemPolicy,
    );
    return {
      ...scope,
      filesystemPolicy,
      ...(options.processAuthorization === undefined
        ? {}
        : { processAuthorization: options.processAuthorization }),
      pathResolver,
      filesystem: policyAwareFilesystem,
      discovery: this.discovery,
      textSearch: this.textSearch,
      patch: createRuntimePatchService(
        pathResolver,
        createPolicyAwarePatchMutationFileSystem(
          createLocalPatchMutationFileSystem(logicalRoot),
          pathResolver,
          filesystemPolicy,
        ),
      ),
      exec: new LocalRuntimeExecService({
        pathResolver,
        processManager: this.processManager,
        shellResolver: this.shellResolver,
        ...(options.processAuthorization === undefined
          ? {}
          : { authorization: options.processAuthorization }),
        requireAuthorization:
          options.filesystemPolicy !== undefined || options.processAuthorization !== undefined,
      }),
      git: this.git ?? new LocalGitService({ logicalRoot, pathResolver }),
    };
  }

  async dispose(): Promise<void> {
    await this.processManager.dispose();
  }

  async cancelOwnedResources(ownerRunId: import("@caelush/protocol").RunId) {
    const result = await this.processManager.cancelOwnedByRun(ownerRunId);
    return {
      stoppedResourceIds: result.stoppedProcessIds,
      confirmed: result.confirmed,
    };
  }
}
