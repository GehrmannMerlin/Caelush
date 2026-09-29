import {
  WorkspaceIdSchema,
  WorkspaceRecordSchema,
  type CreateWorkspaceRequest,
  type WorkspaceId,
  type WorkspaceRecord,
  type WorkspaceRef,
} from "@caelush/protocol";
import {
  StorageNotFoundError,
  type RunRepository,
  type SessionRepository,
  type WorkspaceRepository,
} from "@caelush/storage";
import {
  canonicalizeWorkspacePath,
  createStableWorkspaceId,
  displayNameForWorkspacePath,
  WorkspacePathError,
} from "./workspace-identity.js";
import { ActiveRunConflictError } from "./workspace-errors.js";

export { WorkspacePathError } from "./workspace-identity.js";

export interface WorkspaceServiceOptions {
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
    return this.options.repository.list(limit);
  }

  async removeWorkspace(id: WorkspaceId): Promise<void> {
    const workspaceId = WorkspaceIdSchema.parse(id);
    if (this.options.sessions !== undefined && this.options.runs !== undefined) {
      const sessions = await this.options.sessions.listByWorkspace(workspaceId);
      for (const session of sessions) {
        const runs = await this.options.runs.listBySession(session.id);
        if (runs.some((run) => !isTerminalRunStatus(run.status))) {
          throw new ActiveRunConflictError();
        }
      }
    }
    await this.options.repository.remove(workspaceId);
  }

  toWorkspaceRef(workspace: WorkspaceRecord): WorkspaceRef {
    const parsed = WorkspaceRecordSchema.parse(workspace);
    return { id: parsed.id, path: parsed.canonicalPath };
  }
}

function isTerminalRunStatus(status: string): boolean {
  return [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMEOUT",
    "MAX_STEPS_REACHED",
    "BUDGET_EXCEEDED",
  ].includes(status);
}
