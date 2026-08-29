import type { WorkspaceRef } from "@caelush/protocol";
import type { RuntimeFileDiscovery } from "./discovery/file-discovery.js";
import type { RuntimeFileSystem } from "./filesystem/types.js";
import type { RuntimeTextSearch } from "./search/text-search.js";
import type { WorkspacePathResolver } from "./workspace-path.js";
import type { RuntimePatchService } from "./patch/service.js";

export interface RuntimeWorkspaceScope {
  readonly workspace: WorkspaceRef;
  readonly logicalRoot: string;
  readonly realRoot: string;
  readonly pathResolver: WorkspacePathResolver;
  readonly filesystem: RuntimeFileSystem;
  readonly discovery: RuntimeFileDiscovery;
  readonly textSearch: RuntimeTextSearch;
  readonly patch: RuntimePatchService;
}
