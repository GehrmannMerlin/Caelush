import type {
  BuiltModelContext,
  ContextBuildInput,
  ContextUsageProjection,
  ProjectIntelligenceSnapshot,
  RelevantFileContextPlan,
} from "@caelush/context";
import { ContextExhaustedError } from "@caelush/context";
import type { ModelDescriptor } from "@caelush/ai";
import type {
  AgentTurnInput,
  ContextBuildContribution,
  ContextBuildReport,
  ContextEnginePort,
  ContextPrepareInput,
  ContextPrepareMode,
  ContextPressure,
  PreparedModelContext,
  ToolObservationPolicySnapshot,
} from "@caelush/agent";
import type { LLMMessage, LLMUserMessage } from "@caelush/llm/messages";
import type { AgentRun, WorkspaceRef } from "@caelush/protocol";
import type {
  AgentContextBuilderPort,
  AgentContextRuntimePort,
  AgentProjectInspectorPort,
  AgentRelevantFilePlannerPort,
} from "./agent-loop-ports.js";
import { defaultObservationPolicy } from "./agent-tool-batch.js";
import { toAIMessage, toLegacyMessage, toProtocolJsonObject } from "./ai-invocation-projection.js";

/**
 * TRANSITIONAL — the legacy Context runtime behind the frozen Context Engine boundary.
 *
 * Phase 3B froze `ContextEnginePort`: one call prepares everything the model will be shown,
 * and the general loop never learns how it was built. The current Context System still works
 * from a `ProjectIntelligenceSnapshot`, a `RelevantFileContextPlan`, a `ContextBuildInput`
 * and legacy durable `LLMMessage`s, so this adapter is where that knowledge lives:
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
  readonly baseSystemPrompt: string;
  readonly contextLimits: import("@caelush/context").ContextBuildLimits;
  /** The run's workspace, needed only for the legacy project inspection input. */
  readonly workspace: WorkspaceRef;
  /** The optional workspace-relative working directory for this session. */
  readonly cwd?: string;
  readonly explicitPaths?: readonly string[];
  /** Supplies the verification-repair context for a repair continuation. */
  readonly verificationRepairContext?: () => Promise<
    import("@caelush/context").VerificationRepairContextInput | undefined
  >;
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
      const history = input.history.map(toLegacyMessage);
      const legacyInput = await buildLegacyContextInput(dependencies, input, history);
      // The single descriptor authority for this build. Never re-resolved.
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
  history: readonly LLMMessage[],
): Promise<ContextBuildInput> {
  const snapshot = await inspect(dependencies);
  const relevantFiles = await plan(dependencies, input, snapshot);

  const common = {
    baseSystemPrompt: dependencies.baseSystemPrompt,
    snapshot,
    ...(relevantFiles === undefined ? {} : { relevantFiles }),
    history,
    limits: dependencies.contextLimits,
    ...(await repairContext(dependencies, input)),
  };

  const currentTurnMessages = currentTurn(input.input, history);
  if (currentTurnMessages !== undefined) {
    return { ...common, mode: "TOOL_CONTINUATION", currentTurnMessages };
  }
  return {
    ...common,
    currentUserMessage: currentUserMessage(input.input, input.identity.goal),
  };
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

/**
 * The current turn's own messages for a legacy tool continuation.
 *
 * A `TOOL_RESULTS` turn knows its own assistant message and results, so the legacy
 * `TOOL_CONTINUATION` shape is reconstructed from the frozen turn input rather than from a
 * second copy of the conversation. That keeps the frozen boundary free of a
 * `currentTurnMessages` field.
 */
function currentTurn(
  input: AgentTurnInput,
  history: readonly LLMMessage[],
): readonly LLMMessage[] | undefined {
  if (input.kind !== "TOOL_RESULTS") return undefined;
  const pending = toLegacyAssistantContent(input.pendingDecision.modelTurn.assistantMessage);
  // The open user turn is the last user message before this turn; it must stay inside the
  // continuation so the tool results are never orphaned from the request that produced them.
  // The frozen boundary carries it as the history's last user message in this phase.
  const currentUser = [...history].reverse().find((message) => message.role === "user");
  return [
    ...(currentUser === undefined ? [] : [currentUser]),
    pending,
    ...input.results.map(toLegacyMessage),
  ];
}

/** Project one AI assistant message onto the durable legacy assistant message. */
function toLegacyAssistantContent(message: import("@caelush/ai").AIAssistantMessage): LLMMessage {
  const content = message.content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "tool-call" as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: toProtocolJsonObject(part.input),
        },
  );
  return { role: "assistant", content };
}

/**
 * The legacy `currentUserMessage` of a turn the frozen input does not phrase as one.
 *
 * A `CONTINUATION` is a Reason that carries no new user message: the Run continues from where
 * it was, and the frozen contract deliberately expresses that as a reason rather than as text.
 * The legacy builder still requires a current user message, so the compatibility boundary maps
 * the continuation onto the Run's own goal — which is exactly the prompt the previous loop
 * produced — instead of widening the frozen interface with a message the caller never sent.
 *
 * A continuation that *does* carry messages uses its last one, so a future steering or repair
 * message stays authoritative over the goal.
 */
function currentUserMessage(input: AgentTurnInput, goal: string): LLMUserMessage {
  if (input.kind === "USER_INPUT") {
    const last = input.messages.at(-1);
    if (last !== undefined) return { role: "user", content: last.content };
  }
  if (input.kind === "CONTINUATION") {
    const last = input.messages?.at(-1);
    if (last !== undefined) return { role: "user", content: last.content };
    return { role: "user", content: goal };
  }
  throw new Error("a user turn requires at least one user message");
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
    messages: built.messages.map(toAIMessage),
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
