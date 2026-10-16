import {
  WorkspaceIdSchema,
  WorkspaceRecordSchema,
  createTimestampMs,
  type CreateWorkspaceRequest,
  type WorkspaceId,
  type WorkspaceRecord,
  type WorkspaceRef,
} from "@caelush/protocol";
import {
  StorageNotFoundError,
  StorageError,
  type ArchiveStore,
  type RunRepository,
  type SessionRepository,
  type WorkspaceRepository,
} from "@caelush/storage";
import {
  canonicalizeWorkspacePath,
  createStableWorkspaceId,
  displayNameForWorkspacePath,
} from "./workspace-identity.js";
import { requireUnarchivedTarget } from "../services/archive-access.js";

export { WorkspacePathError } from "./workspace-identity.js";

export interface WorkspaceServiceOptions {
  readonly archives?: ArchiveStore;
  readonly repository: WorkspaceRepository;
  readonly sessions?: SessionRepository;
  readonly runs?: RunRepository;
  readonly now?: () => number;
}

export interface WorkspaceRegistration {
  readonly workspace: WorkspaceRecord;
  readonly created: boolean;
}

export class WorkspaceService {
  private readonly now: () => number;

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async registerWorkspace(input: CreateWorkspaceRequest): Promise<WorkspaceRegistration> {
    const canonicalPath = canonicalizeWorkspacePath(input.path);
    const existing = await this.options.repository.getByCanonicalPath(canonicalPath);
    if (existing !== null) {
      await requireUnarchivedTarget(this.options.archives, {
        type: "WORKSPACE",
        workspaceId: existing.id,
      });
      return {
        workspace: await this.options.repository.touch(existing.id, this.now()),
        created: false,
      };
    }

    const timestamp = this.now();
    const displayName = input.displayName?.trim() || displayNameForWorkspacePath(canonicalPath);
    const workspace = WorkspaceRecordSchema.parse({
      id: createStableWorkspaceId(canonicalPath),
      canonicalPath,
      displayName,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: timestamp,
    });

    try {
      await this.options.repository.insert(workspace);
      return { workspace, created: true };
    } catch (error) {
      // A second daemon request may win the unique canonical-path race. Resolve it to the same
      // registry identity instead of surfacing a spurious conflict to the caller.
      const raced = await this.options.repository.getByCanonicalPath(canonicalPath);
      if (raced !== null) {
        return {
          workspace: await this.options.repository.touch(raced.id, this.now()),
          created: false,
        };
      }
      throw error;
    }
  }

  async getWorkspace(id: WorkspaceId): Promise<WorkspaceRecord | null> {
    return this.options.repository.getById(WorkspaceIdSchema.parse(id));
  }

  async requireWorkspace(id: WorkspaceId): Promise<WorkspaceRecord> {
    const workspace = await this.getWorkspace(id);
    if (workspace === null) {
      throw new StorageNotFoundError("Workspace", id);
    }
    return workspace;
  }

  async listWorkspaces(limit?: number): Promise<WorkspaceRecord[]> {
    return this.options.archives === undefined
      ? this.options.repository.list(limit)
      : this.options.archives.listActiveWorkspaces(limit);
  }

  async removeWorkspace(id: WorkspaceId): Promise<void> {
    const workspaceId = WorkspaceIdSchema.parse(id);
    if (this.options.archives === undefined)
      throw new StorageError("Durable archive management is unavailable.");
    await this.options.archives.archive(
      { type: "WORKSPACE", workspaceId },
      createTimestampMs(this.now()),
    );
  }

  toWorkspaceRef(workspace: WorkspaceRecord): WorkspaceRef {
    const parsed = WorkspaceRecordSchema.parse(workspace);
    return { id: parsed.id, path: parsed.canonicalPath };
  }
}
