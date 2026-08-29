import path from "node:path";
import { WorkspaceRefSchema, type RuntimeRef, type WorkspaceRef } from "@caelush/protocol";
import { LocalRuntimeFileDiscovery } from "./discovery/file-discovery.js";
import type { RuntimeFileDiscovery } from "./discovery/file-discovery.js";
import { LocalRuntimeFileSystem } from "./filesystem/local-filesystem.js";
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

export interface LocalRuntimeOptions {
  readonly filesystem?: RuntimeFileSystem;
  readonly discovery?: RuntimeFileDiscovery;
  readonly textSearch?: RuntimeTextSearch;
}

export class LocalRuntime implements Runtime {
  readonly kind = LOCAL_RUNTIME_KIND;
  private readonly filesystem: RuntimeFileSystem;
  private readonly discovery: RuntimeFileDiscovery;
  private readonly textSearch: RuntimeTextSearch;

  constructor(options: LocalRuntimeOptions = {}) {
    this.filesystem = options.filesystem ?? new LocalRuntimeFileSystem();
    this.discovery = options.discovery ?? new LocalRuntimeFileDiscovery();
    this.textSearch = options.textSearch ?? new LocalRipgrepRunner();
  }

  supports(ref: RuntimeRef): boolean {
    return ref.kind === this.kind;
  }

  async openWorkspace(workspace: WorkspaceRef): Promise<RuntimeWorkspaceScope> {
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
    const scope = {
      workspace: parsed.data,
      logicalRoot,
      realRoot,
      filesystem: this.filesystem,
    } as const;
    return {
      ...scope,
      pathResolver: new WorkspacePathResolver(scope),
      discovery: this.discovery,
      textSearch: this.textSearch,
      patch: createRuntimePatchService(
        new WorkspacePathResolver(scope),
        createLocalPatchMutationFileSystem(),
      ),
    };
  }
}
