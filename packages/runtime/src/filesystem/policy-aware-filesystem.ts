import type { RuntimeFilesystemPolicy } from "../security/runtime-boundary.js";
import type {
  ResolvedFilesystemTarget,
  RuntimeFilesystemOperation,
  WorkspacePathResolver,
} from "../workspace-path.js";
import type { RuntimeFileSystem } from "./types.js";
import type { PatchMutationFileSystem } from "../patch/types.js";

/**
 * The raw local filesystem is deliberately kept behind this policy-bound view. Every read resolves
 * the target again immediately before opening it, so a symlink/reparse replacement cannot turn a
 * previously admitted workspace path into an external read.
 */
export class PolicyAwareRuntimeFileSystem implements RuntimeFileSystem {
  constructor(
    private readonly base: RuntimeFileSystem,
    private readonly resolver: WorkspacePathResolver,
    private readonly policy: RuntimeFilesystemPolicy,
  ) {}

  async getMetadata(absolutePath: string) {
    const target = await this.resolve(absolutePath, "READ", true);
    return this.base.getMetadata(target.absolutePath);
  }

  async fingerprint(absolutePath: string) {
    const target = await this.resolve(absolutePath, "READ", false);
    return this.base.fingerprint(target.canonicalPath);
  }

  async realpath(absolutePath: string): Promise<string> {
    const target = await this.resolve(absolutePath, "READ", false);
    return target.canonicalPath;
  }

  async readDirectory(absolutePath: string) {
    const target = await this.resolve(absolutePath, "LIST", false);
    return this.base.readDirectory(target.canonicalPath);
  }

  async readTextFile(
    absolutePath: string,
    options: { readonly offset: number; readonly limit: number; readonly maxBytes: number },
  ) {
    const target = await this.resolve(absolutePath, "READ", false);
    return this.base.readTextFile(target.canonicalPath, options);
  }

  private resolve(
    absolutePath: string,
    operation: RuntimeFilesystemOperation,
    allowMissing: boolean,
  ): Promise<ResolvedFilesystemTarget> {
    return this.resolver.resolveFilesystemTarget({
      path: absolutePath,
      policy: this.policy,
      operation,
      allowMissing,
    });
  }
}

/**
 * Patch mutations use a separate narrow adapter because the patch committer owns rollback and
 * verification. The adapter re-admits every low-level mutation and keeps the existing ancestor
 * symlink checks as a second line of defense.
 */
export function createPolicyAwarePatchMutationFileSystem(
  base: PatchMutationFileSystem,
  resolver: WorkspacePathResolver,
  policy: RuntimeFilesystemPolicy,
): PatchMutationFileSystem {
  const resolve = (
    absolutePath: string,
    operation: RuntimeFilesystemOperation,
    allowMissing: boolean,
  ) =>
    resolver.resolveFilesystemTarget({
      path: absolutePath,
      policy,
      operation,
      allowMissing,
    });

  return {
    async readFileBytes(absolutePath) {
      const target = await resolve(absolutePath, "READ", false);
      return base.readFileBytes(target.canonicalPath);
    },
    async getMetadata(absolutePath) {
      const target = await resolve(absolutePath, "READ", true);
      return base.getMetadata(target.absolutePath);
    },
    async writePatchFile(absolutePath, bytes) {
      const target = await resolve(absolutePath, "WRITE", true);
      await base.writePatchFile(target.absolutePath, bytes);
    },
    async removePatchFile(absolutePath) {
      const target = await resolve(absolutePath, "DELETE", false);
      await base.removePatchFile(target.absolutePath);
    },
    async movePatchFile(sourcePath, destinationPath) {
      const source = await resolve(sourcePath, "MOVE", false);
      const destination = await resolve(destinationPath, "MOVE", true);
      await base.movePatchFile(source.absolutePath, destination.absolutePath);
    },
    async makePatchDirectory(absolutePath) {
      const target = await resolve(absolutePath, "WRITE", true);
      await base.makePatchDirectory(target.absolutePath);
    },
    async removePatchDirectoryIfEmpty(absolutePath) {
      const target = await resolve(absolutePath, "DELETE", false);
      await base.removePatchDirectoryIfEmpty(target.absolutePath);
    },
  };
}
