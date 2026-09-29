import {
  AgentRunSchema,
  type AgentSession,
  compatibilityLimitsForResourcePolicy,
  createRunId,
  normalizeCreateRunResourcePolicy,
  type AgentRun,
  type CreateRunRequest,
  type ModelRef,
  type RunId,
  type RunListQuery,
  type WorkspaceRef,
  type SessionId,
} from "@caelush/protocol";
import { StorageNotFoundError, type RunRepository, type SessionRepository } from "@caelush/storage";
import type { DaemonModelCanonicalizer } from "../providers/model-canonicalizer.js";
import { canonicalizeWorkspacePath } from "../workspaces/workspace-identity.js";
import { WorkspaceOwnershipError } from "../workspaces/workspace-errors.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";

export interface RunServiceOptions {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly now?: () => number;
  readonly createId?: typeof createRunId;
  readonly modelCanonicalizer?: DaemonModelCanonicalizer;
  readonly workspaceService?: WorkspaceService;
}

export class RunService {
  private readonly now: () => number;
  private readonly createId: typeof createRunId;
  private readonly modelCanonicalizer: DaemonModelCanonicalizer;

  constructor(private readonly options: RunServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? createRunId;
    this.modelCanonicalizer = options.modelCanonicalizer ?? {
      canonicalize: (selection): ModelRef => ({ ...selection }),
    };
  }

  async createRun(sessionId: SessionId, input: CreateRunRequest): Promise<AgentRun> {
    const session = await this.requireSession(sessionId);
    const workspace = await this.resolveWorkspace(session, input.workspace);
    const resourcePolicy = normalizeCreateRunResourcePolicy(input);
    const run = AgentRunSchema.parse({
      id: this.createId(),
      sessionId,
      ...input,
      workspace,
      limits: input.limits ?? compatibilityLimitsForResourcePolicy(resourcePolicy),
      resourcePolicy,
      model: this.modelCanonicalizer.canonicalize(input.model),
      status: "PENDING",
      createdAt: this.now(),
    });
    await this.options.runs.insert(run);
    return run;
  }

  async getRun(id: RunId): Promise<AgentRun> {
    const run = await this.options.runs.get(id);
    if (!run) throw new StorageNotFoundError("AgentRun", id);
    return run;
  }

  async listRuns(sessionId: SessionId, query: RunListQuery): Promise<AgentRun[]> {
    await this.requireSession(sessionId);
    const options =
      query.status === undefined
        ? { limit: query.limit }
        : { limit: query.limit, status: query.status };
    return this.options.runs.listBySession(sessionId, options);
  }

  private async requireSession(sessionId: SessionId) {
    const session = await this.options.sessions.get(sessionId);
    if (session === null) {
      throw new StorageNotFoundError("AgentSession", sessionId);
    }
    return session;
  }

  private async resolveWorkspace(
    session: AgentSession,
    requested: WorkspaceRef,
  ): Promise<WorkspaceRef> {
    if (this.options.workspaceService === undefined) return requested;
    if (session.workspaceId === undefined) {
      throw new WorkspaceOwnershipError("The legacy Session has no unambiguous Workspace owner.");
    }
    const workspace = await this.options.workspaceService.requireWorkspace(session.workspaceId);
    let requestedPath: string;
    try {
      requestedPath = canonicalizeWorkspacePath(requested.path);
    } catch {
      throw new WorkspaceOwnershipError("The requested Run Workspace path is invalid.");
    }
    if (requested.id !== workspace.id || requestedPath !== workspace.canonicalPath) {
      throw new WorkspaceOwnershipError("The requested Run Workspace does not match its Session.");
    }
    return this.options.workspaceService.toWorkspaceRef(workspace);
  }
}
