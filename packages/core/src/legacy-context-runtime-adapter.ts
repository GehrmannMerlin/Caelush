import { createHash } from "node:crypto";
import type {
  BuiltModelContext,
  ContextBuildInput,
  ContextArtifactRepository,
  ContextUsageProjection,
  ContextItem,
  Artifact,
  ProjectIntelligenceSnapshot,
  RelevantFileContextPlan,
} from "@caelush/context";
import {
  ContextExhaustedError,
  createContextItem,
  projectContextContributions,
} from "@caelush/context";
import type { ModelDescriptor } from "@caelush/ai";
import type {
  AgentConversationSnapshot,
  AgentMessageProjectorRegistry,
  ContextBuildContribution,
  ContextBuildReport,
  ContextEnginePort,
  ContextPrepareInput,
  ContextPrepareMode,
  ContextPressure,
  ContextContribution,
  ContextContributionPipeline,
  PreparedModelContext,
  RunExecutionMode,
  ToolObservationPolicySnapshot,
  ConversationSelector,
} from "@caelush/agent";
import {
  createConversationSelector,
  createStandardAgentMessageProjectorRegistry,
  projectStoredMessages,
  STRUCTURAL_TOKEN_ESTIMATOR,
} from "@caelush/agent";
import type { AIMessage, AIUserMessage, AIToolResultMessage } from "@caelush/ai";
import type { AgentRun, WorkspaceRef } from "@caelush/protocol";
import type {
  AgentContextBuilderPort,
  AgentContextRuntimePort,
  AgentProjectInspectorPort,
  AgentRelevantFilePlannerPort,
} from "./agent-loop-ports.js";
import { defaultObservationPolicy } from "./agent-tool-batch.js";

/**
 * TRANSITIONAL — the legacy Context runtime behind the frozen Context Engine boundary.
 *
 * Phase 3B froze `ContextEnginePort`: one call prepares everything the model will be shown,
 * and the general loop never learns how it was built. The current Context System still works
 * from a `ProjectIntelligenceSnapshot`, a `RelevantFileContextPlan`, a `ContextBuildInput`
 * and durable Agent messages projected to AI messages, so this adapter is where that knowledge lives:
 *
 * ```text
 * Workspace/project context  →  PreparedModelContext
 * ```
 *
 * Two boundaries are enforced here and nowhere else:
 *
 * ```text
 * @caelush/agent never imports @caelush/context
 * the general loop never sees a project, a Git state, a workspace path or a file plan
 * ```
 *
 * The adapter also carries the pieces a general context engine would not have: the base
 * system prompt, the context limits and the verification-repair input. Those are legacy
 * Context configuration, and they must not become fields of the frozen boundary.
 *
 * It disappears when Context Engineering V2 owns real context assembly.
 */

/** Where the legacy adapter gets the pieces its legacy collaborators need. */
export interface LegacyContextRuntimeAdapterDependencies {
  readonly inspector?: AgentProjectInspectorPort;
  readonly planner?: AgentRelevantFilePlannerPort;
  readonly contextBuilder: AgentContextBuilderPort;
  readonly contextRuntime?: AgentContextRuntimePort;
  /** The production Message V2 projector authority. */
  readonly conversationProjectors?: AgentMessageProjectorRegistry;
  /** The production Message V2 selection authority. */
  readonly conversationSelector?: ConversationSelector;
  readonly baseSystemPrompt: string;
  readonly contextLimits: import("@caelush/context").ContextBuildLimits;
  /** The run's workspace, needed only for the legacy project inspection input. */
  readonly workspace: WorkspaceRef;
  /** The optional workspace-relative working directory for this session. */
  readonly cwd?: string;
  readonly explicitPaths?: readonly string[];
  /**
   * Where the raw output pointer of each Tool result is resolved from.
   *
   * ```text
   * frozen AgentTurnInput.TOOL_RESULTS   bounded summaries and no artifact pointer
   *        ↓
   * this resolver                        the durable Tool execution ledger
   *        ↓
   * legacy Context-only Tool message     carries `rawArtifactRef` again
   * ```
   *
   * A forced recovery re-projects Tool output under a tighter policy, and it needs the *raw* output
   * to do it. The frozen turn input deliberately carries only the model-facing projection, so the
   * pointer is resolved here — at the compatibility boundary that needs it — rather than added to a
   * general Agent contract that has no artifact store.
   *
   * Absent, or resolving to `undefined`, the legacy message falls back to the bounded `content` it
   * already carries. That is the honest behaviour for an externally submitted Tool result, which
   * has no durable Tool invocation behind it at all.
   */
  readonly rawObservationRefs?: import("./run-tool-observation-recovery.js").ToolRawObservationRefResolver;
  /** The run's identity, needed only to resolve a raw observation pointer. */
  readonly runId?: import("@caelush/protocol").RunId;
  /** Supplies the verification-repair context for a repair continuation. */
  readonly verificationRepairContext?: () => Promise<
    import("@caelush/context").VerificationRepairContextInput | undefined
  >;
  /**
   * Supplies this turn's Tool usage guidance.
   *
   * ```text
   * the frozen ContextPrepareInput.tools   the tools THIS turn exposes
   *        ↓
   * this supplier                          their canonical Coding prompt snippets
   *        ↓
   * the budgeted Context build             one <tool_guidance> block inside the system message
   * ```
   *
   * ## Why the supplier takes the turn's own tool list
   *
   * The frozen boundary already carries the resolved tool specs for the turn, so nothing new crosses
   * into the general kernel. Taking the names as an argument rather than a pre-built block is what makes
   * "guidance for the active set, in registry order" a property of the composition rather than
   * something a caller has to remember: a host supplies the snippet *lookup*, and this adapter supplies
   * the set.
   *
   * ## Why it is not a field of the frozen contract
   *
   * `ContextPrepareInput` is the general Kernel's boundary and has no Coding field — deliberately, and
   * Phase 4E does not add one. Tool guidance is Coding product content delivered through a compatibility
   * seam that already exists, which is the same shape the base system prompt and the context limits
   * already use.
   */
  readonly toolGuidance?: (
    activeToolNames: readonly string[],
  ) => Promise<readonly import("@caelush/context").ContextItem[]>;
  /** The Agent-owned Context Contribution pipeline; the adapter is its only Context consumer. */
  readonly contextContributionPipeline?: ContextContributionPipeline;
  /** Read/write artifact port supplied by the composition root, never by a Hook instance. */
  readonly contextArtifacts?: ContextArtifactRepository;
  readonly contextContributionPipelineId?: string;
  /** Durable Run mode, distinct from ContextPrepareMode.FORCED_RECOVERY. */
  readonly runMode?: RunExecutionMode;
  readonly now?: () => import("@caelush/protocol").TimestampMs;
}

/**
 * Create the legacy Context Engine over the current Context System.
 *
 * There is deliberately no `ModelCatalog` here. `ContextPrepareInput.model` is the descriptor
 * this turn was resolved against, and it is the *only* model authority a context build has:
 * re-resolving the same `ModelRef` through a catalog inside the adapter would mean two lookups
 * of one identity, free to disagree if the catalog ever changed between them. The descriptor
 * arrives resolved, and this adapter uses it as given.
 *
 * There is deliberately no `providers` option either. The frozen `ContextProvider` seam exists
 * and is conformance-tested, but the legacy Context system assembles system context, conversation
 * and relevant files itself and has no injection point that could consume a `ContextItem` without
 * changing prompt order or the token budget. Declaring support that production ignores would be a
 * misleading API, so the option is absent until Context Engineering V2 owns a real pipeline.
 */
export function createLegacyContextRuntimeAdapter(
  dependencies: LegacyContextRuntimeAdapterDependencies,
): ContextEnginePort {
  return {
    async prepare(input: ContextPrepareInput): Promise<PreparedModelContext> {
      const projectedConversation = await projectConversationForContext(dependencies, input);
      const legacyInput = await buildLegacyContextInput(dependencies, input, projectedConversation); // The single descriptor authority for this build. Never re-resolved.
      const descriptor = input.model;
      const runtime = resolveRuntime(dependencies);

      // A forced recovery is a promise about the *answer*, not about the attempt. The legacy
      // builder re-renders the same input, so it cannot produce a smaller context; answering a
      // forced recovery with it would spend a second provider call on the request the provider
      // just rejected. Refusing here is what the frozen boundary requires, and it is why the
      // prepared context carries no `recovered` flag any more.
      if (input.mode === "FORCED_RECOVERY" && dependencies.contextRuntime === undefined) {
        throw new ContextExhaustedError();
      }

      const built = await runtime.prepareModelContext({
        runId: input.identity.runId,
        providerId: descriptor.ref.provider,
        modelId: descriptor.ref.model,
        projectId: dependencies.workspace.id,
        model: descriptor,
        context: legacyInput,
        signal: input.signal,
        authorities: contextAuthorities(input),
        ...(input.mode === "FORCED_RECOVERY" ? { forceRecovery: true } : {}),
      });

      return toPreparedModelContext(built, runtime, input.identity.runId, input.mode);
    },
  };
}

/**
 * Resolve the context runtime.
 *
 * A configured runtime is the authority. Otherwise the legacy builder is wrapped in the
 * Context package's own builder adapter, which is exactly the compatibility path the previous
 * loop used, so a host that supplied only a builder keeps working unchanged.
 */
function resolveRuntime(
  dependencies: LegacyContextRuntimeAdapterDependencies,
): AgentContextRuntimePort {
  if (dependencies.contextRuntime !== undefined) return dependencies.contextRuntime;
  return createBuilderRuntime(dependencies.contextBuilder);
}

/**
 * Adapt a bare legacy builder to the runtime port.
 *
 * This mirrors `createContextRuntimeBuilderAdapter` in `@caelush/context` for the one method
 * the boundary needs. It lives here rather than importing the Context helper so the Core
 * boundary owns the whole compatibility decision in one file.
 */
function createBuilderRuntime(builder: AgentContextBuilderPort): AgentContextRuntimePort {
  return {
    prepareModelContext(request): BuiltModelContext {
      return builder.build(request.context);
    },
  };
}

async function buildLegacyContextInput(
  dependencies: LegacyContextRuntimeAdapterDependencies,
  input: ContextPrepareInput,
  conversation: ProjectedLegacyConversation,
): Promise<ContextBuildInput> {
  const snapshot = await inspect(dependencies);
  const relevantFiles = await plan(dependencies, input, snapshot);
  const contextContributionItems = await prepareContextContributions(dependencies, input);

  const common = {
    baseSystemPrompt: dependencies.baseSystemPrompt,
    snapshot,
    ...(relevantFiles === undefined ? {} : { relevantFiles }),
    history: conversation.history,
    limits: dependencies.contextLimits,
    ...(await toolGuidance(dependencies, input)),
    ...(await repairContext(dependencies, input)),
    ...(contextContributionItems === undefined || contextContributionItems.length === 0
      ? {}
      : { contextContributionItems }),
  };

  const currentTurnMessages = conversation.currentTurnMessages;
  if (currentTurnMessages !== undefined) {
    return {
      ...common,
      mode: "TOOL_CONTINUATION",
      currentTurnMessages,
      ...(conversation.rawObservationRefs === undefined
        ? {}
        : { rawObservationRefs: conversation.rawObservationRefs }),
    };
  }
  return {
    ...common,
    currentUserMessage: requireCurrentUserMessage(conversation),
  };
}

interface ProjectedLegacyConversation {
  readonly history: readonly AIMessage[];
  readonly currentTurnMessages?: readonly AIMessage[];
  readonly currentUserMessage?: AIUserMessage;
  readonly rawObservationRefs?: readonly {
    readonly toolCallId: string;
    readonly artifactRef: string;
  }[];
}

const CONTEXT_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
const CONTEXT_CONTRIBUTION_SNAPSHOT_KIND = "CONTEXT_CONTRIBUTION_SNAPSHOT";
const CONTEXT_CONTRIBUTION_SNAPSHOT_MIME = "application/vnd.caelush.context-contribution+json";

interface ContextContributionSnapshotContribution {
  readonly id: string;
  readonly source: string;
  readonly replay: "SNAPSHOT";
  readonly items: readonly ContextItem[];
}

interface ContextContributionSnapshotPayload {
  readonly schemaVersion: typeof CONTEXT_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION;
  readonly identity: {
    readonly runId: string;
    readonly sessionId: string;
    readonly stepId: string;
    readonly sequence: number;
  };
  readonly pipelineId: string;
  readonly sourceRef: string;
  readonly replay: "SNAPSHOT";
  readonly contributions: readonly ContextContributionSnapshotContribution[];
  readonly receipts: readonly {
    readonly pipeline: string;
    readonly hookId: string;
    readonly outcome: "APPLIED" | "SKIPPED" | "FAILED";
    readonly startedAt: number;
    readonly finishedAt: number;
    readonly inputFingerprint?: string;
    readonly outputFingerprint?: string;
  }[];
}

interface ContextContributionSnapshotEnvelope extends ContextContributionSnapshotPayload {
  readonly integrity: { readonly payloadHash: string };
}

class ContextContributionSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextContributionSnapshotError";
  }
}

async function prepareContextContributions(
  dependencies: LegacyContextRuntimeAdapterDependencies,
  input: ContextPrepareInput,
): Promise<readonly ContextItem[] | undefined> {
  const pipeline = dependencies.contextContributionPipeline;
  if (pipeline === undefined || !pipeline.hasHooks) return undefined;
  const pipelineId = dependencies.contextContributionPipelineId ?? "context-contribution";
  const identity = snapshotIdentity(input, pipelineId);
  const existing = await readContextContributionSnapshot(dependencies.contextArtifacts, identity);
  if (existing !== undefined) return existing;

  if (dependencies.runMode === "RECOVER" || input.mode === "FORCED_RECOVERY") {
    throw new ContextContributionSnapshotError(
      "A Context Contribution snapshot required for recovery is unavailable.",
    );
  }

  const result = await pipeline.run(
    {
      identity: input.identity,
      turn: input.turn,
      mode: input.mode,
      goal: input.identity.goal,
    },
    {
      identity: {
        runId: input.identity.runId,
        sessionId: input.identity.sessionId,
      },
      stepId: input.turn.stepId,
      mode: dependencies.runMode ?? "EXECUTE",
      signal: input.signal,
    },
  );
  if (input.signal.aborted)
    throw new ContextContributionSnapshotError("Context preparation was cancelled.");

  const projectionOptions = {
    runId: input.identity.runId,
    sequence: input.turn.sequence,
  };
  const allItems = projectContextContributions(result.contributions, projectionOptions);
  const snapshotContributions = result.contributions.filter(
    (contribution): contribution is ContextContribution & { readonly replay: "SNAPSHOT" } =>
      contribution.replay === "SNAPSHOT",
  );
  if (snapshotContributions.length > 0) {
    const payload: ContextContributionSnapshotPayload = {
      schemaVersion: CONTEXT_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION,
      identity: {
        runId: input.identity.runId,
        sessionId: input.identity.sessionId,
        stepId: input.turn.stepId,
        sequence: input.turn.sequence,
      },
      pipelineId,
      sourceRef: identity.sourceRef,
      replay: "SNAPSHOT",
      contributions: snapshotContributions.map((contribution) => ({
        id: contribution.id,
        source: contribution.source,
        replay: "SNAPSHOT" as const,
        items: projectContextContributions([contribution], projectionOptions),
      })),
      receipts: result.receipts.map((receipt) => ({
        pipeline: receipt.pipeline,
        hookId: receipt.hookId,
        outcome: receipt.outcome,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt,
        ...(receipt.inputFingerprint === undefined
          ? {}
          : { inputFingerprint: receipt.inputFingerprint }),
        ...(receipt.outputFingerprint === undefined
          ? {}
          : { outputFingerprint: receipt.outputFingerprint }),
      })),
    };
    await persistContextContributionSnapshot(
      dependencies.contextArtifacts,
      identity,
      payload,
      dependencies,
    );
  }
  return allItems;
}

function snapshotIdentity(
  input: ContextPrepareInput,
  pipelineId: string,
): {
  readonly artifactId: string;
  readonly sourceRef: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly stepId: string;
  readonly sequence: number;
  readonly pipelineId: string;
} {
  const sourceRef = [
    "run",
    input.identity.runId,
    "session",
    input.identity.sessionId,
    "turn",
    input.turn.stepId,
    String(input.turn.sequence),
    "pipeline",
    pipelineId,
    "schema",
    String(CONTEXT_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION),
  ].join(":");
  const digest = createHash("sha256").update(sourceRef, "utf8").digest("hex");
  return {
    artifactId: `context-contribution-snapshot:${digest}`,
    sourceRef,
    runId: input.identity.runId,
    sessionId: input.identity.sessionId,
    stepId: input.turn.stepId,
    sequence: input.turn.sequence,
    pipelineId,
  };
}

async function readContextContributionSnapshot(
  repository: ContextArtifactRepository | undefined,
  identity: ReturnType<typeof snapshotIdentity>,
): Promise<readonly ContextItem[] | undefined> {
  if (repository === undefined) return undefined;
  const artifact = await repository.readInternal(identity.artifactId);
  if (artifact === undefined) return undefined;
  return validateContextContributionSnapshot(artifact, identity);
}

async function persistContextContributionSnapshot(
  repository: ContextArtifactRepository | undefined,
  identity: ReturnType<typeof snapshotIdentity>,
  payload: ContextContributionSnapshotPayload,
  dependencies: LegacyContextRuntimeAdapterDependencies,
): Promise<void> {
  if (repository === undefined) {
    throw new ContextContributionSnapshotError(
      "Context Contribution snapshots require the composition root's artifact repository.",
    );
  }
  const payloadText = JSON.stringify(payload);
  const envelope: ContextContributionSnapshotEnvelope = {
    ...payload,
    integrity: {
      payloadHash: createHash("sha256").update(payloadText, "utf8").digest("hex"),
    },
  };
  const content = JSON.stringify(envelope);
  const artifact = await repository.createOrGet({
    artifactId: identity.artifactId,
    runId: identity.runId,
    kind: CONTEXT_CONTRIBUTION_SNAPSHOT_KIND,
    sourceRef: identity.sourceRef,
    content,
    mimeType: CONTEXT_CONTRIBUTION_SNAPSHOT_MIME,
    sensitivity: "INTERNAL",
    createdSequence: identity.sequence,
    createdAt: dependencies.now?.() ?? (Date.now() as import("@caelush/protocol").TimestampMs),
  });
  validateContextContributionSnapshot(artifact, identity);
}

function validateContextContributionSnapshot(
  artifact: Artifact,
  identity: ReturnType<typeof snapshotIdentity>,
): readonly ContextItem[] {
  if (
    artifact.artifactId !== identity.artifactId ||
    artifact.runId !== identity.runId ||
    artifact.kind !== CONTEXT_CONTRIBUTION_SNAPSHOT_KIND ||
    artifact.sourceRef !== identity.sourceRef ||
    artifact.mimeType !== CONTEXT_CONTRIBUTION_SNAPSHOT_MIME ||
    artifact.sensitivity !== "INTERNAL" ||
    artifact.createdSequence !== identity.sequence ||
    artifact.byteLength !== Buffer.byteLength(artifact.content, "utf8") ||
    artifact.contentHash !== createHash("sha256").update(artifact.content, "utf8").digest("hex")
  ) {
    throw new ContextContributionSnapshotError(
      "Context Contribution snapshot metadata is incompatible.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.content) as unknown;
  } catch {
    throw new ContextContributionSnapshotError(
      "Context Contribution snapshot content is malformed.",
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new ContextContributionSnapshotError(
      "Context Contribution snapshot envelope is malformed.",
    );
  }
  const envelope = parsed;
  const envelopeIdentity = envelope.identity;
  const envelopeIntegrity = envelope.integrity;
  if (
    envelope.schemaVersion !== CONTEXT_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION ||
    envelope.pipelineId !== identity.pipelineId ||
    envelope.sourceRef !== identity.sourceRef ||
    envelope.replay !== "SNAPSHOT" ||
    !isPlainRecord(envelopeIdentity) ||
    envelopeIdentity.runId !== identity.runId ||
    envelopeIdentity.sessionId !== identity.sessionId ||
    envelopeIdentity.stepId !== identity.stepId ||
    envelopeIdentity.sequence !== identity.sequence ||
    !isPlainRecord(envelopeIntegrity) ||
    typeof envelopeIntegrity.payloadHash !== "string" ||
    !Array.isArray(envelope.contributions)
  ) {
    throw new ContextContributionSnapshotError(
      "Context Contribution snapshot identity is incompatible.",
    );
  }
  const payload: ContextContributionSnapshotPayload = {
    schemaVersion: CONTEXT_CONTRIBUTION_SNAPSHOT_SCHEMA_VERSION,
    identity: {
      runId: identity.runId,
      sessionId: identity.sessionId,
      stepId: identity.stepId,
      sequence: identity.sequence,
    },
    pipelineId: identity.pipelineId,
    sourceRef: identity.sourceRef,
    replay: "SNAPSHOT",
    contributions: parseSnapshotContributions(envelope.contributions),
    receipts: parseSnapshotReceipts(envelope.receipts),
  };
  const expectedPayloadHash = createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
  if (expectedPayloadHash !== (envelopeIntegrity as Record<string, unknown>).payloadHash) {
    throw new ContextContributionSnapshotError(
      "Context Contribution snapshot integrity check failed.",
    );
  }
  return Object.freeze(payload.contributions.flatMap((contribution) => [...contribution.items]));
}

function parseSnapshotContributions(
  value: unknown[],
): readonly ContextContributionSnapshotContribution[] {
  return Object.freeze(
    value.map((candidate) => {
      if (
        !isPlainRecord(candidate) ||
        typeof candidate.id !== "string" ||
        typeof candidate.source !== "string" ||
        candidate.replay !== "SNAPSHOT" ||
        !Array.isArray(candidate.items)
      ) {
        throw new ContextContributionSnapshotError(
          "Context Contribution snapshot contribution is malformed.",
        );
      }
      return Object.freeze({
        id: candidate.id,
        source: candidate.source,
        replay: "SNAPSHOT" as const,
        items: Object.freeze(candidate.items.map(parseSnapshotItem)),
      });
    }),
  );
}

function parseSnapshotReceipts(value: unknown): ContextContributionSnapshotPayload["receipts"] {
  if (!Array.isArray(value)) {
    throw new ContextContributionSnapshotError(
      "Context Contribution snapshot receipts are malformed.",
    );
  }
  return Object.freeze(
    value.map((candidate) => {
      if (
        !isPlainRecord(candidate) ||
        typeof candidate.pipeline !== "string" ||
        typeof candidate.hookId !== "string" ||
        !["APPLIED", "SKIPPED", "FAILED"].includes(String(candidate.outcome)) ||
        typeof candidate.startedAt !== "number" ||
        typeof candidate.finishedAt !== "number"
      ) {
        throw new ContextContributionSnapshotError(
          "Context Contribution snapshot receipt is malformed.",
        );
      }
      return Object.freeze({
        pipeline: candidate.pipeline,
        hookId: candidate.hookId,
        outcome: candidate.outcome as "APPLIED" | "SKIPPED" | "FAILED",
        startedAt: candidate.startedAt,
        finishedAt: candidate.finishedAt,
        ...(typeof candidate.inputFingerprint === "string"
          ? { inputFingerprint: candidate.inputFingerprint }
          : {}),
        ...(typeof candidate.outputFingerprint === "string"
          ? { outputFingerprint: candidate.outputFingerprint }
          : {}),
      });
    }),
  );
}

function parseSnapshotItem(value: unknown): ContextItem {
  if (
    !isPlainRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.sourceRef !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.retention !== "string" ||
    typeof value.priorityClass !== "string" ||
    typeof value.tokenEstimate !== "number" ||
    typeof value.cacheStability !== "string" ||
    typeof value.freshness !== "string" ||
    typeof value.sensitivity !== "string" ||
    typeof value.whyLoaded !== "string" ||
    typeof value.createdSequence !== "number" ||
    typeof value.updatedSequence !== "number" ||
    typeof value.content !== "string"
  ) {
    throw new ContextContributionSnapshotError("Context Contribution snapshot item is malformed.");
  }
  try {
    return createContextItem({
      id: value.id,
      type: value.type as ContextItem["type"],
      sourceRef: value.sourceRef,
      scope: value.scope as ContextItem["scope"],
      retention: value.retention as ContextItem["retention"],
      priorityClass: value.priorityClass as ContextItem["priorityClass"],
      tokenEstimate: value.tokenEstimate,
      cacheStability: value.cacheStability as ContextItem["cacheStability"],
      freshness: value.freshness as ContextItem["freshness"],
      sensitivity: value.sensitivity as ContextItem["sensitivity"],
      whyLoaded: value.whyLoaded,
      createdSequence: value.createdSequence,
      updatedSequence: value.updatedSequence,
      content: value.content,
    });
  } catch {
    throw new ContextContributionSnapshotError("Context Contribution snapshot item is invalid.");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The one production conversation projection path.
 *
 * Durable records are validated and selected as Agent messages first. Only the selected
 * provider-neutral AI conversation crosses the adapter directly into the
 * existing Context materializer. A historical Tool result is therefore read from its stored
 * `projectedContent`; this function never projects raw observations or chooses a newer version.
 */
async function projectConversationForContext(
  dependencies: LegacyContextRuntimeAdapterDependencies,
  input: ContextPrepareInput,
): Promise<ProjectedLegacyConversation> {
  const projectors =
    dependencies.conversationProjectors ?? createStandardAgentMessageProjectorRegistry();
  const selector =
    dependencies.conversationSelector ?? createConversationSelector({ projector: projectors });
  const durableConversation: AgentConversationSnapshot = input.conversation;
  const selected = selector.select({
    conversation: durableConversation,
    maxTokens:
      dependencies.contextLimits.maxConversationTokens ?? dependencies.contextLimits.maxInputTokens,
    estimator: STRUCTURAL_TOKEN_ESTIMATOR,
  });
  const stored = selected.turns.flatMap((turn) => [...turn.messages]);
  const byId = new Map(stored.map((entry) => [entry.message.id, entry]));
  const historyWithout = (ids: ReadonlySet<string>): readonly AIMessage[] =>
    projectStoredMessages(
      stored.filter((entry) => !ids.has(entry.message.id)),
      projectors,
    ).messages;

  if (input.input.kind === "USER_INPUT") {
    const user = byId.get(input.input.userMessageId);
    if (user === undefined || user.message.type !== "USER") {
      throw new Error("The durable USER message referenced by the turn input is unavailable.");
    }
    const projected = projectors.project(user).messages;
    const currentUser = projected.find(
      (message): message is AIUserMessage => message.role === "user",
    );
    if (currentUser === undefined) {
      throw new Error("The durable USER message did not produce a model-visible user message.");
    }
    return {
      history: historyWithout(new Set([user.message.id])),
      currentUserMessage: currentUser,
    };
  }

  if (input.input.kind === "TOOL_RESULTS") {
    const toolInput = input.input;
    const assistant = stored.find(
      (entry) =>
        entry.message.type === "ASSISTANT" && entry.message.sourceStepId === toolInput.sourceStepId,
    );
    if (assistant === undefined) {
      throw new Error("The durable assistant message for the Tool continuation is unavailable.");
    }
    const assistantIndex = stored.indexOf(assistant);
    const user = [...stored.slice(0, assistantIndex)]
      .reverse()
      .find((entry) => entry.message.type === "USER");
    if (user === undefined) {
      throw new Error("The durable user message for the Tool continuation is unavailable.");
    }
    const resultEntries = toolInput.toolResultMessageIds.map((id) => {
      const entry = byId.get(id);
      if (entry === undefined || entry.message.type !== "TOOL_RESULT") {
        throw new Error("A durable Tool result referenced by the turn input is unavailable.");
      }
      return entry;
    });
    const currentIds = new Set([
      user.message.id,
      assistant.message.id,
      ...resultEntries.map((entry) => entry.message.id),
    ]);
    const projectedResults = resultEntries.flatMap((entry) => projectors.project(entry).messages);
    const rawObservationRefs = await resolveRawObservationRefs(
      dependencies,
      input.identity.runId,
      toolInput.sourceStepId,
      projectedResults,
    );
    return {
      history: historyWithout(currentIds),
      currentTurnMessages: [
        ...projectors.project(user).messages,
        ...projectors.project(assistant).messages,
        ...projectedResults,
      ],
      ...(rawObservationRefs.length === 0 ? {} : { rawObservationRefs }),
    };
  }

  const currentEntries = (input.input.messageIds ?? []).map((id) => {
    const entry = byId.get(id);
    if (entry === undefined) {
      throw new Error(
        "A durable continuation message referenced by the turn input is unavailable.",
      );
    }
    return entry;
  });
  const currentMessages = currentEntries.flatMap((entry) => projectors.project(entry).messages);
  const currentUserEntry =
    [...currentEntries].reverse().find((entry) => entry.message.type === "USER") ??
    [...stored].reverse().find((entry) => entry.message.type === "USER");
  const currentUser =
    [...currentMessages]
      .reverse()
      .find((message): message is AIUserMessage => message.role === "user") ??
    (currentUserEntry === undefined
      ? undefined
      : projectors
          .project(currentUserEntry)
          .messages.find((message): message is AIUserMessage => message.role === "user"));
  if (currentUser === undefined || currentUserEntry === undefined) {
    throw new Error("The durable user message for the continuation is unavailable.");
  }
  const currentIds = new Set([
    ...currentEntries.map((entry) => entry.message.id),
    currentUserEntry.message.id,
  ]);
  return {
    history: historyWithout(currentIds),
    currentUserMessage: currentUser,
  };
}

/**
 * The Tool guidance block for this turn, if the host supplies one.
 *
 * The names come from the frozen `ContextPrepareInput.tools` — the tools this turn actually exposes,
 * in the order the loop resolved them — and are handed to the supplier unchanged. A supplier that has
 * no snippet for a name returns nothing for it, so a generic Agent Tool simply contributes no guidance
 * rather than a placeholder that would describe a Tool nobody declared.
 *
 * An empty result contributes no key at all: the legacy build input stays exactly as it was for a host
 * with no Coding Tools.
 */
async function toolGuidance(
  dependencies: LegacyContextRuntimeAdapterDependencies,
  input: ContextPrepareInput,
): Promise<{
  readonly toolGuidanceItems?: readonly import("@caelush/context").ContextItem[];
}> {
  if (dependencies.toolGuidance === undefined) return {};
  const items = await dependencies.toolGuidance(input.tools.map((tool) => tool.name));
  return items.length === 0 ? {} : { toolGuidanceItems: items };
}

async function inspect(
  dependencies: LegacyContextRuntimeAdapterDependencies,
): Promise<ProjectIntelligenceSnapshot> {
  if (dependencies.inspector === undefined) return emptySnapshot(dependencies.workspace);
  const snapshotInput =
    dependencies.cwd === undefined
      ? { workspace: dependencies.workspace }
      : { workspace: dependencies.workspace, cwd: dependencies.cwd };
  return dependencies.inspector.inspect(snapshotInput);
}

/**
 * Plan the relevant files for this turn.
 *
 * The snapshot is passed in rather than re-inspected: project inspection is the expensive part
 * of preparation, and inspecting twice per turn would double it. A planner without an inspector
 * contributes nothing, because a file plan is only meaningful against discovered project facts.
 */
async function plan(
  dependencies: LegacyContextRuntimeAdapterDependencies,
  input: ContextPrepareInput,
  snapshot: ProjectIntelligenceSnapshot,
): Promise<RelevantFileContextPlan | undefined> {
  if (dependencies.planner === undefined || dependencies.inspector === undefined) return undefined;
  const query =
    dependencies.explicitPaths === undefined
      ? { text: input.identity.goal }
      : { text: input.identity.goal, explicitPaths: dependencies.explicitPaths };
  return dependencies.planner.plan({ snapshot, query });
}

async function repairContext(
  dependencies: LegacyContextRuntimeAdapterDependencies,
  input: ContextPrepareInput,
): Promise<{
  readonly verificationRepairContext?: import("@caelush/context").VerificationRepairContextInput;
}> {
  if (input.input.kind !== "CONTINUATION") return {};
  if (input.input.reason !== "VERIFICATION_REPAIR") return {};
  const repair = await dependencies.verificationRepairContext?.();
  return repair === undefined ? {} : { verificationRepairContext: repair };
}

function requireCurrentUserMessage(conversation: ProjectedLegacyConversation): AIUserMessage {
  if (conversation.currentUserMessage !== undefined) return conversation.currentUserMessage;
  throw new Error("The durable conversation has no model-visible user message for this turn.");
}

/**
 * COMPATIBILITY ONLY: resolve a raw observation pointer for the legacy Context runtime.
 *
 * Phase 5D historical replay never calls this seam: stored TOOL_RESULT projectedContent is the
 * replay authority. The resolver remains available for still-legacy Context integration paths
 * until the deferred 5F retirement.
 */
export async function resolveRawObservationRef(
  dependencies: LegacyContextRuntimeAdapterDependencies,
  runId: import("@caelush/protocol").RunId,
  sourceStepId: import("@caelush/protocol").StepId,
  result: import("@caelush/ai").AIToolResultMessage,
): Promise<string | undefined> {
  if (dependencies.rawObservationRefs === undefined) return undefined;
  return dependencies.rawObservationRefs.resolve({
    runId,
    sourceStepId,
    externalCallId: result.toolCallId,
  });
}

async function resolveRawObservationRefs(
  dependencies: LegacyContextRuntimeAdapterDependencies,
  runId: import("@caelush/protocol").RunId,
  sourceStepId: import("@caelush/protocol").StepId,
  messages: readonly AIMessage[],
): Promise<readonly { readonly toolCallId: string; readonly artifactRef: string }[]> {
  if (dependencies.rawObservationRefs === undefined) return [];
  const toolMessages = messages.filter(
    (message): message is AIToolResultMessage => message.role === "tool",
  );
  const resolved = await Promise.all(
    toolMessages.map(async (message) => ({
      toolCallId: message.toolCallId,
      artifactRef: await resolveRawObservationRef(dependencies, runId, sourceStepId, message),
    })),
  );
  return resolved.filter(
    (reference): reference is { readonly toolCallId: string; readonly artifactRef: string } =>
      reference.artifactRef !== undefined,
  );
}

/**
 * Project the legacy built context onto the frozen prepared context.
 *
 * Two projections happen here and nowhere else:
 *
 * ```text
 * the legacy build report  →  the frozen typed ContextBuildReport
 * the runtime's policy     →  the frozen ToolObservationPolicySnapshot
 * ```
 *
 * The observation policy is lifted out of the runtime and travels with the prepared context,
 * so the Run Layer can snapshot it durably at a Tool boundary instead of re-deriving it after
 * a restart. Everything the legacy report carries beyond the frozen shape — instruction
 * counts, project root, diagnostics, build trace — stays inside this adapter: a general agent
 * contract has no field for it, and inventing one would leak project semantics into the kernel.
 */
function toPreparedModelContext(
  built: BuiltModelContext,
  runtime: AgentContextRuntimePort,
  runId: string,
  mode: ContextPrepareMode,
): PreparedModelContext {
  const usage = runtime.getContextUsage?.(runId);
  const policy = runtime.getContextPolicy?.(runId);
  return {
    messages: built.messages,
    report: toContextBuildReport(built, usage, mode),
    observationPolicy: toObservationPolicy(policy),
  };
}

/**
 * A defensive view of the legacy build report.
 *
 * The legacy report belongs to `@caelush/context`, and this adapter is the compatibility boundary
 * that reads it. A host may supply a builder whose report does not carry every section, so the
 * read is total: the frozen report is always well formed, and the adapter never turns a
 * compatibility producer's missing section into a failure.
 */
interface LegacyReportView {
  readonly estimatedInputTokens?: number;
  readonly remainingTokens?: number;
  readonly systemTokens?: number;
  readonly limits?: { readonly maxInputTokens?: number };
  readonly currentTurn?: { readonly messageCount?: number; readonly estimatedTokens?: number };
  readonly conversation?: {
    readonly selectedMessages?: number;
    readonly droppedMessages?: number;
    readonly droppedTurns?: number;
    readonly estimatedTokensUsed?: number;
    readonly requiresCompaction?: boolean;
  };
  readonly relevantFiles?: {
    readonly providedFiles?: number;
    readonly selectedFiles?: number;
    readonly droppedFiles?: number;
    readonly furtherTruncatedFiles?: number;
    readonly estimatedTokensUsed?: number;
  };
  readonly system?: { readonly instructionCount?: number };
}

function legacyReport(built: BuiltModelContext): LegacyReportView {
  return (built.report ?? {}) as LegacyReportView;
}

/**
 * Project the legacy report onto the frozen typed one.
 *
 * The legacy runtime's own usage projection is authoritative when it exists: it is the only
 * source that knows the *effective* input limit after reserves, the pressure state and how
 * many compactions really ran. The builder fallback derives the same fields from the report
 * it produced, so a host without the runtime keeps a truthful report instead of a fabricated
 * one.
 */
function toContextBuildReport(
  built: BuiltModelContext,
  usage: ContextUsageProjection | undefined,
  mode: ContextPrepareMode,
): ContextBuildReport {
  const report = legacyReport(built);
  return {
    estimatedInputTokens: usage?.estimatedInputTokens ?? report.estimatedInputTokens ?? 0,
    effectiveInputLimitTokens:
      usage?.effectiveInputLimitTokens ?? report.limits?.maxInputTokens ?? 0,
    remainingTokens: usage?.remainingTokens ?? report.remainingTokens ?? 0,
    pressure: usage?.pressureState ?? derivePressure(built, mode),
    compactionCount: usage?.compactionCount ?? deriveCompactionCount(built, mode),
    contributions: toContributions(built),
  };
}

/**
 * Classify the pressure a build ran under, for a host without a usage projection.
 *
 * A forced recovery is an emergency by definition: the provider already rejected the window.
 * Otherwise the builder's own record of what it had to drop is the signal — it compacts
 * proactively when the conversation needs it or when optional context had to be reduced.
 */
function derivePressure(built: BuiltModelContext, mode: ContextPrepareMode): ContextPressure {
  if (mode === "FORCED_RECOVERY") return "EMERGENCY";
  const report = legacyReport(built);
  const reduced =
    report.conversation?.requiresCompaction === true ||
    (report.conversation?.droppedMessages ?? 0) > 0 ||
    (report.relevantFiles?.droppedFiles ?? 0) > 0 ||
    (report.relevantFiles?.furtherTruncatedFiles ?? 0) > 0;
  return reduced ? "PROACTIVE" : "NORMAL";
}

/**
 * How many reductions this build performed, for a host without a usage projection.
 *
 * The legacy builder truncates rather than summarizing, so a dropped conversation tail and a
 * truncated file set each count as one reduction. A real runtime reports its own, larger
 * number, which is the one that reaches this contract when it exists.
 */
function deriveCompactionCount(built: BuiltModelContext, mode: ContextPrepareMode): number {
  const report = legacyReport(built);
  const conversation = (report.conversation?.droppedTurns ?? 0) > 0 ? 1 : 0;
  const files = (report.relevantFiles?.furtherTruncatedFiles ?? 0) > 0 ? 1 : 0;
  const forced = mode === "FORCED_RECOVERY" ? 1 : 0;
  return conversation + files + forced;
}

/**
 * Project the legacy report's sections onto the frozen contribution list.
 *
 * The contributor labels are this adapter's own stable identifiers, never project facts: the
 * kernel receives an opaque `providerId` and a count, and never learns what a contributor is.
 * Order is fixed so two builds of the same context produce the same report.
 */
function toContributions(built: BuiltModelContext): readonly ContextBuildContribution[] {
  const report = legacyReport(built);
  const contributions: ContextBuildContribution[] = [
    {
      providerId: "system",
      tokenEstimate: report.systemTokens ?? 0,
      itemCount: report.system?.instructionCount ?? 0,
      droppedItems: 0,
      truncatedItems: 0,
    },
    {
      providerId: "conversation",
      tokenEstimate: report.conversation?.estimatedTokensUsed ?? 0,
      itemCount: report.conversation?.selectedMessages ?? 0,
      droppedItems: report.conversation?.droppedMessages ?? 0,
      truncatedItems: 0,
    },
    {
      providerId: "current-turn",
      tokenEstimate: report.currentTurn?.estimatedTokens ?? 0,
      itemCount: report.currentTurn?.messageCount ?? 0,
      droppedItems: 0,
      truncatedItems: 0,
    },
  ];
  if ((report.relevantFiles?.providedFiles ?? 0) > 0) {
    contributions.push({
      providerId: "relevant-files",
      tokenEstimate: report.relevantFiles?.estimatedTokensUsed ?? 0,
      itemCount: report.relevantFiles?.selectedFiles ?? 0,
      droppedItems: report.relevantFiles?.droppedFiles ?? 0,
      truncatedItems: report.relevantFiles?.furtherTruncatedFiles ?? 0,
    });
  }
  return contributions;
}

/**
 * Project the runtime's observation policy onto the frozen snapshot.
 *
 * The frozen contract names exactly the two numbers the legacy policy already owns, so this is
 * a field-for-field conversion rather than a translation. A host that configured no runtime
 * policy falls back to the legacy Core's own documented default — the same one its Tool result
 * projection already uses — so the two boundaries cannot disagree about how much of a Tool
 * result a model may see.
 */
function toObservationPolicy(
  policy:
    | { readonly maxSingleObservationTokens: number; readonly maxObservationBatchTokens: number }
    | undefined,
): ToolObservationPolicySnapshot {
  return toFrozenObservationPolicy(policy ?? defaultObservationPolicy());
}

function toFrozenObservationPolicy(policy: {
  readonly maxSingleObservationTokens: number;
  readonly maxObservationBatchTokens: number;
}): ToolObservationPolicySnapshot {
  return {
    maxSingleObservationTokens: policy.maxSingleObservationTokens,
    maxObservationBatchTokens: policy.maxObservationBatchTokens,
  };
}

/** The legacy context authority snapshot. It stays inside this adapter. */
function contextAuthorities(input: ContextPrepareInput): {
  readonly goal: string;
} {
  return { goal: input.identity.goal };
}

/**
 * A structurally valid empty project snapshot.
 *
 * A test host may configure a builder without an inspector. An empty snapshot is the honest
 * representation of "nothing was discovered", and it keeps the legacy builder's own validation
 * satisfied without inventing project facts.
 */
function emptySnapshot(workspace: WorkspaceRef): ProjectIntelligenceSnapshot {
  return {
    workspace: {
      id: workspace.id,
      path: workspace.path,
    },
    projectRoot: { root: workspace.path, evidence: [], confidence: "NONE" },
    environment: { platform: "unknown", nodeVersion: undefined },
    profile: { languages: [], packageManagers: [], manifests: [], confidence: "NONE" },
    instructions: { files: [], combined: "" },
    diagnostics: [],
  } as unknown as ProjectIntelligenceSnapshot;
}

/** Re-exported so a host can name the run type it resolves a workspace from. */
export type { AgentRun, ModelDescriptor };
