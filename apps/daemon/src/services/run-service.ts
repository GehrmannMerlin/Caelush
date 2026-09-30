import {
  AgentRunSchema,
  type AgentSession,
  compatibilityLimitsForResourcePolicy,
  createRunId,
  normalizeCreateRunResourcePolicy,
  type AgentRun,
  type CreateRunRequest,
  type ClientModelSelection,
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
import { ModelSelectionError } from "../providers/model-directory.js";

export interface RunServiceOptions {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly now?: () => number;
  readonly createId?: typeof createRunId;
  readonly modelCanonicalizer?: DaemonModelCanonicalizer;
  readonly workspaceService?: WorkspaceService;
  readonly validateSelection?: (
    selection: {
      readonly provider: string;
      readonly model: string;
      readonly reasoningLevel?: import("@caelush/protocol").ReasoningLevel;
    },
    context?: { readonly explicitModel: boolean },
  ) => Promise<void>;
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
    const resourcePolicy = normalizeCreateRunResourcePolicy(input);
    const modelSelection: ClientModelSelection | undefined =
      input.model ??
      (session.defaultModel === undefined
        ? undefined
        : { provider: session.defaultModel.provider, model: session.defaultModel.model });
    if (modelSelection === undefined) {
      throw new ModelSelectionError("NO_MODEL_SELECTED", "No model is selected for this Run.");
    }
    const sessionModelMatchesRequest =
      input.model === undefined ||
      (session.defaultModel !== undefined &&
        session.defaultModel.provider === input.model.provider &&
        session.defaultModel.model === input.model.model);
    const reasoningLevel =
      input.reasoningLevel ??
      (sessionModelMatchesRequest ? session.defaultReasoningLevel : undefined);
    if (this.options.validateSelection !== undefined) {
      await this.options.validateSelection(
        {
          provider: modelSelection.provider,
          model: modelSelection.model,
          ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
        },
        { explicitModel: input.model !== undefined },
      );
    }
    const workspace = await this.resolveWorkspace(session, input.workspace);
    const run = AgentRunSchema.parse({
      id: this.createId(),
      sessionId,
      ...input,
      workspace,
      limits: input.limits ?? compatibilityLimitsForResourcePolicy(resourcePolicy),
      resourcePolicy,
      model: this.modelCanonicalizer.canonicalize(modelSelection),
      ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
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
