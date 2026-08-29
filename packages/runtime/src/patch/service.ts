import { commitPatch } from "./committer.js";
import { parsePatch } from "./parser.js";
import { preparePatch } from "./planner.js";
import type { PatchCommitResult, PatchMutationFileSystem, RuntimePatchRequest } from "./types.js";
import type { WorkspacePathResolver } from "../workspace-path.js";

export class RuntimePatchService {
  constructor(
    private readonly pathResolver: Pick<WorkspacePathResolver, "resolveMutationTarget">,
    private readonly filesystem: PatchMutationFileSystem,
  ) {}

  async apply(request: RuntimePatchRequest): Promise<PatchCommitResult> {
    const document = parsePatch(request.patch);
    const prepared = await preparePatch(document, {
      pathResolver: this.pathResolver,
      filesystem: this.filesystem,
    });
    return commitPatch(prepared, this.filesystem);
  }
}
