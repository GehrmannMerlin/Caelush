import {
  AgentSessionSchema,
  createSessionId,
  type AgentSession,
  type CreateSessionRequest,
  type ClientModelSelectionWithReasoning,
  type ModelRef,
  type SessionId,
} from "@caelush/protocol";
import type { SessionRepository } from "@caelush/storage";
import { StorageNotFoundError } from "@caelush/storage";
import type { DaemonModelCanonicalizer } from "../providers/model-canonicalizer.js";
import { canonicalizeWorkspacePath } from "../workspaces/workspace-identity.js";
import { WorkspaceOwnershipError } from "../workspaces/workspace-errors.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ModelSelectionError } from "../providers/model-directory.js";

export interface SessionServiceOptions {
  readonly repository: SessionRepository;
  readonly now?: () => number;
  readonly createId?: typeof createSessionId;
  readonly modelCanonicalizer?: DaemonModelCanonicalizer;
  readonly workspaceService?: WorkspaceService;
  readonly defaultSelection?: () => Promise<ClientModelSelectionWithReasoning | undefined>;
  readonly validateSelection?: (selection: {
    readonly provider: string;
    readonly model: string;
    readonly reasoningLevel?: import("@caelush/protocol").ReasoningLevel;
  }) => Promise<void>;
}

export class SessionService {
  private readonly now: () => number;
  private readonly createId: typeof createSessionId;
  private readonly modelCanonicalizer: DaemonModelCanonicalizer;

  constructor(private readonly options: SessionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? createSessionId;
    this.modelCanonicalizer = options.modelCanonicalizer ?? {
      canonicalize: (selection): ModelRef => ({ ...selection }),
    };
  }

  async createSession(input: CreateSessionRequest): Promise<AgentSession> {
    const timestamp = this.now();
    let workspaceId = input.workspaceId;
    let defaultWorkspace = input.defaultWorkspace;
    if (this.options.workspaceService !== undefined) {
      if (workspaceId !== undefined) {
        const workspace = await this.options.workspaceService.requireWorkspace(workspaceId);
        const canonicalRef = this.options.workspaceService.toWorkspaceRef(workspace);
        if (defaultWorkspace !== undefined) {
          let requestedPath: string;
          try {
            requestedPath = canonicalizeWorkspacePath(defaultWorkspace.path);
          } catch {
            throw new WorkspaceOwnershipError("The requested Workspace path is invalid.");
          }
          if (defaultWorkspace.id !== canonicalRef.id || requestedPath !== canonicalRef.path) {
            throw new WorkspaceOwnershipError(
              "The requested Workspace does not match the Registry.",
            );
          }
        }
        defaultWorkspace = canonicalRef;
      } else if (defaultWorkspace !== undefined) {
        const registration = await this.options.workspaceService.registerWorkspace({
          path: defaultWorkspace.path,
        });
        workspaceId = registration.workspace.id;
        defaultWorkspace = this.options.workspaceService.toWorkspaceRef(registration.workspace);
      } else {
        throw new WorkspaceOwnershipError();
      }
    }
    let defaultModel = input.defaultModel;
    let defaultReasoningLevel = input.defaultReasoningLevel;
    if (defaultModel === undefined && defaultReasoningLevel !== undefined) {
      throw new ModelSelectionError(
        "MODEL_UNAVAILABLE",
        "A reasoning level requires a selected model.",
      );
    }
    if (defaultModel === undefined && this.options.defaultSelection !== undefined) {
      const selection = await this.options.defaultSelection();
      if (selection !== undefined) {
        defaultModel = { provider: selection.provider, model: selection.model };
        defaultReasoningLevel = selection.reasoningLevel;
      }
    }
    if (defaultModel !== undefined && this.options.validateSelection !== undefined) {
      await this.options.validateSelection({
        provider: defaultModel.provider,
        model: defaultModel.model,
        ...(defaultReasoningLevel === undefined ? {} : { reasoningLevel: defaultReasoningLevel }),
      });
    }
    const session = AgentSessionSchema.parse({
      id: this.createId(),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(defaultWorkspace === undefined ? {} : { defaultWorkspace }),
      ...(defaultModel === undefined
        ? {}
        : { defaultModel: this.modelCanonicalizer.canonicalize(defaultModel) }),
      ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel }),
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ?? {},
    });
    await this.options.repository.insert(session);
    return session;
  }

  async getSession(id: SessionId): Promise<AgentSession> {
    const session = await this.options.repository.get(id);
    if (!session) throw new StorageNotFoundError("AgentSession", id);
    return session;
  }

  async listSessions(limit: number): Promise<AgentSession[]> {
    return this.options.repository.list({ limit });
  }
}
