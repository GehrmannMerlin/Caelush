import {
  AgentRunSchema,
  type AgentSession,
  compatibilityLimitsForResourcePolicy,
  createEventId,
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
import {
  createRunEventFactory,
  type DurableRunEvent,
  type RunEventFactory,
  type RunEventNotifierPort,
} from "@caelush/agent";
import { expandPermissionPreset } from "@caelush/security";
import { StorageNotFoundError, type RunRepository, type SessionRepository } from "@caelush/storage";
import type {
  PermissionPresetSelection,
  WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";
import type { DaemonModelCanonicalizer } from "../providers/model-canonicalizer.js";
import { canonicalizeWorkspacePath } from "../workspaces/workspace-identity.js";
import { WorkspaceOwnershipError } from "../workspaces/workspace-errors.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { ModelSelectionError } from "../providers/model-directory.js";
import type { SecurityCapabilityService } from "./security-capability-service.js";

export class SecurityPolicyRequestError extends Error {
  constructor(
    readonly reason:
      | "CAPABILITY_UNAVAILABLE"
      | "PRESET_NOT_AVAILABLE"
      | "PREPARATION_REQUIRED"
      | "PRESET_VERSION_MISMATCH"
      | "PERSISTENCE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "SecurityPolicyRequestError";
  }
}

export interface RunServiceOptions {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly now?: () => number;
  readonly createId?: typeof createRunId;
  readonly modelCanonicalizer?: DaemonModelCanonicalizer;
  readonly workspaceService?: WorkspaceService;
  readonly securityCapabilityService?: Pick<SecurityCapabilityService, "getWorkspaceCapabilities">;
  readonly eventNotifier?: Pick<RunEventNotifierPort, "notifyCommitted">;
  readonly eventFactory?: RunEventFactory;
  readonly eventIdFactory?: { readonly create: () => import("@caelush/protocol").EventId };
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
  private readonly eventFactory: RunEventFactory;
  private readonly eventIdFactory: {
    readonly create: () => import("@caelush/protocol").EventId;
  };

  constructor(private readonly options: RunServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? createRunId;
    this.modelCanonicalizer = options.modelCanonicalizer ?? {
      canonicalize: (selection): ModelRef => ({ ...selection }),
    };
    this.eventFactory = options.eventFactory ?? createRunEventFactory();
    this.eventIdFactory = options.eventIdFactory ?? { create: createEventId };
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
    const { preset, ...clientFields } = input;
    const securityPolicy = await this.resolveSecurityPolicy(workspace.id, preset);
    const run = AgentRunSchema.parse({
      id: this.createId(),
      sessionId,
      ...clientFields,
      workspace,
      limits: input.limits ?? compatibilityLimitsForResourcePolicy(resourcePolicy),
      resourcePolicy,
      model: this.modelCanonicalizer.canonicalize(modelSelection),
      securityPolicy,
      permissionProfile: securityPolicy.permissionProfile,
      approvalPolicy: securityPolicy.approvalPolicy,
      completionContract: "NATURAL_V1",
      ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
      status: "PENDING",
      createdAt: this.now(),
    });
    const policyEvent = this.eventFactory.runSecurityPolicyBound(
      run,
      securityPolicy,
      this.eventIdFactory.create(),
      run.createdAt,
    );
    if (this.options.runs.insertWithEvents === undefined) {
      throw new SecurityPolicyRequestError(
        "PERSISTENCE_UNAVAILABLE",
        "Atomic Run security policy persistence is unavailable; the Run was not created.",
      );
    }
    const committedEvents: readonly DurableRunEvent[] = await this.options.runs.insertWithEvents(
      run,
      [policyEvent],
    );
    if (committedEvents.length > 0) {
      this.options.eventNotifier?.notifyCommitted(committedEvents);
    }
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

  private async resolveSecurityPolicy(
    workspaceId: WorkspaceRef["id"],
    selection: PermissionPresetSelection,
  ) {
    if (this.options.securityCapabilityService === undefined) {
      throw new SecurityPolicyRequestError(
        "CAPABILITY_UNAVAILABLE",
        "Security capabilities are unavailable; the Run cannot be created safely.",
      );
    }
    let capabilities: WorkspaceSecurityCapabilitiesResponse;
    try {
      capabilities =
        await this.options.securityCapabilityService.getWorkspaceCapabilities(workspaceId);
    } catch {
      throw new SecurityPolicyRequestError(
        "CAPABILITY_UNAVAILABLE",
        "Security capabilities are unavailable; the Run cannot be created safely.",
      );
    }
    const availability = capabilities.presets.find((preset) => preset.id === selection.id);
    if (availability === undefined || availability.version !== selection.expectedVersion) {
      throw new SecurityPolicyRequestError(
        "PRESET_VERSION_MISMATCH",
        "The selected permission preset is stale or unavailable.",
      );
    }
    if (availability.status === "PREPARATION_REQUIRED") {
      throw new SecurityPolicyRequestError(
        "PREPARATION_REQUIRED",
        "The selected workspace requires security preparation before this Run can start.",
      );
    }
    if (availability.status !== "AVAILABLE") {
      throw new SecurityPolicyRequestError(
        "PRESET_NOT_AVAILABLE",
        "The selected permission preset is unavailable on this host.",
      );
    }
    return expandPermissionPreset({
      presetId: selection.id,
      expectedVersion: selection.expectedVersion,
      createdAt: new Date(this.now()).toISOString(),
    });
  }
}
