import type {
  BuiltModelContext,
  ContextBuildInput,
  ProjectIntelligenceSnapshot,
  RelevantFileContextPlan,
} from "@caelush/context";
import type { ModelCatalog, ModelDescriptor } from "@caelush/ai";
import type {
  AgentTurnInput,
  ContextEnginePort,
  ContextPrepareInput,
  ContextProvider,
  ObservationPolicySnapshot,
  PreparedModelContext,
} from "@caelush/agent";
import type { LLMMessage, LLMUserMessage } from "@caelush/llm/messages";
import type { AgentRun, WorkspaceRef } from "@caelush/protocol";
import type {
  AgentContextBuilderPort,
  AgentContextRuntimePort,
  AgentProjectInspectorPort,
  AgentRelevantFilePlannerPort,
} from "./agent-loop-ports.js";
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
  /**
   * The model metadata authority.
   *
   * The legacy context runtime sizes its budget from a `ModelDescriptor`. The loop resolves
   * the run's `ModelRef` through this catalog and hands the descriptor down, so the same
   * immutable descriptor generation backs both the context budget and the model request.
   */
  readonly models: ModelCatalog;
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
  /** Extra providers. Phase 3B freezes the seam; the legacy runtime remains the assembler. */
  readonly providers?: readonly ContextProvider[];
}

/** Create the legacy Context Engine over the current Context System. */
export function createLegacyContextRuntimeAdapter(
  dependencies: LegacyContextRuntimeAdapterDependencies,
): ContextEnginePort {
  return {
    async prepare(input: ContextPrepareInput): Promise<PreparedModelContext> {
      const history = input.history.map(toLegacyMessage);
      const legacyInput = await buildLegacyContextInput(dependencies, input, history);
      const descriptor = dependencies.models.resolve(input.model.ref);
      const runtime = resolveRuntime(dependencies);

      const built = await runtime.prepareModelContext({
        runId: input.identity.runId,
        providerId: input.model.ref.provider,
        modelId: input.model.ref.model,
        projectId: dependencies.workspace.id,
        model: descriptor,
        context: legacyInput,
        signal: input.signal,
        authorities: contextAuthorities(input),
        ...(input.mode === "FORCED_RECOVERY" ? { forceRecovery: true } : {}),
      });

      return toPreparedModelContext(built, runtime, input.identity.runId, input.mode, {
        // A host that configured a real runtime gets the runtime's own recovery path. The
        // builder fallback re-renders the same input, so it cannot produce a smaller context
        // and the loop must not spend a second provider call on it.
        canRecover: dependencies.contextRuntime !== undefined,
      });
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
  return { ...common, currentUserMessage: currentUserMessage(input.input) };
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

function currentUserMessage(input: AgentTurnInput): LLMUserMessage {
  if (input.kind === "USER_INPUT") {
    const last = input.messages.at(-1);
    if (last !== undefined) return { role: "user", content: last.content };
  }
  if (input.kind === "CONTINUATION") {
    const last = input.messages?.at(-1);
    if (last !== undefined) return { role: "user", content: last.content };
  }
  throw new Error("a user turn requires at least one user message");
}

/**
 * Project the legacy built context onto the frozen prepared context.
 *
 * The observation policy is lifted out of the runtime and travels with the prepared context,
 * so the Run Layer can snapshot it durably at a Tool boundary instead of re-deriving it after
 * a restart.
 */
function toPreparedModelContext(
  built: BuiltModelContext,
  runtime: AgentContextRuntimePort,
  runId: string,
  mode: import("@caelush/agent").ContextPrepareMode,
  capability: { readonly canRecover: boolean },
): PreparedModelContext {
  const policy = runtime.getContextPolicy?.(runId);
  return {
    messages: built.messages.map(toAIMessage),
    report: built.report as unknown as Readonly<Record<string, unknown>>,
    ...(policy === undefined ? {} : { observationPolicy: toObservationPolicy(policy) }),
    ...(mode === "FORCED_RECOVERY" ? { recovered: capability.canRecover } : {}),
  };
}

function toObservationPolicy(policy: {
  readonly maxSingleObservationTokens: number;
  readonly maxObservationBatchTokens: number;
}): ObservationPolicySnapshot {
  return {
    id: "context-runtime-observation-policy",
    maxOutputBytes: policy.maxSingleObservationTokens,
    includeDetails: policy.maxObservationBatchTokens > 0,
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
