import type { AIGateway, AIModelRequest } from "@caelush/ai";
import {
  createBranchContextSourceProvider,
  createCheckpointContextSourceProvider,
  createContextCompactionEventFactory,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextMaterializer,
  createContextReceiptBuilder,
  createContextRequestOverheadEstimator,
  createContextRehydrator,
  createContextSourceRegistryBuilder,
  createContextSummarizationRunner,
  createConversationContextSourceProvider,
  createCorePolicyContextSourceProvider,
  createExtensionContributionContextSourceProvider,
  createMemoryContextSourceProvider,
  createV2ContextEngine,
  createUtf8HeuristicTokenEstimator,
  type ContextAuthorityProviderPort,
  type ContextCheckpointProjection,
  type ContextContributionPipeline,
  type ContextSummarizerPort,
  type ContextSourceProvider,
  type ContextSourceRegistration,
  type ContextTokenEstimatorPort,
  type RunEventNotifierPort,
} from "@caelush/agent";
import {
  CODING_CONTEXT_SOURCE_IDS,
  createGitStateContextSourceProvider,
  createNoOpSkillCatalogPort,
  createProjectInstructionContextSourceProvider,
  createProjectMetadataContextSourceProvider,
  createRelevantFileContextSourceProvider,
  createRuntimeFactsContextSourceProvider,
  createSkillCatalogContextSourceProvider,
  createTemporalContextSourceProvider,
  createVerificationRepairContextSourceProvider,
  createWorkspaceContextSourceProvider,
  createLocalCodingContextPorts,
  type LocalCodingContextPorts,
} from "@caelush/coding-agent";
import type { RunAgentContextEngineInput } from "@caelush/core";
import type { ContextContribution, ContextMemoryProjection } from "@caelush/agent";
import {
  createStructuredCheckpoint,
  serializeContextSummarySource,
  type ContextSummarizationInput,
} from "@caelush/agent";
import type { TimestampMs } from "@caelush/protocol";
import type { Runtime } from "@caelush/runtime";
import type { CaelushStorage } from "@caelush/storage";
import { MemoryRetriever } from "@caelush/memory";
import { redactText } from "@caelush/security";
import { createEventId } from "@caelush/protocol";
import type { AgentMessageProjectorRegistry } from "@caelush/agent";

export interface DaemonV2ContextCompositionOptions {
  readonly input: RunAgentContextEngineInput;
  readonly storage: CaelushStorage;
  readonly runtime: Runtime;
  readonly gateway: AIGateway;
  readonly messageProjectors: AgentMessageProjectorRegistry;
  readonly notifier: RunEventNotifierPort;
  readonly contributionPipeline: ContextContributionPipeline;
  readonly clock: { now(): TimestampMs };
}

/**
 * Compose the production Context Engine for one Run.
 *
 * The factory is intentionally per-run: workspace, cwd, explicit paths, repair evidence and
 * contribution execution are host facts. The returned object is still the frozen Agent
 * ContextEnginePort, so none of those facts cross the Kernel seam.
 */
export function createDaemonV2ContextEngine(options: DaemonV2ContextCompositionOptions) {
  const { input } = options;
  const tokenEstimator = createUtf8HeuristicTokenEstimator();
  const codingPorts = createLocalCodingContextPorts({
    runtime: options.runtime,
    workspace: input.run.workspace,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.explicitPaths === undefined ? {} : { explicitPaths: input.explicitPaths }),
  });
  const memoryRetriever = new MemoryRetriever(options.storage.memory);
  const sources = createSourceRegistry({
    input,
    codingPorts,
    tokenEstimator,
    memoryRetriever,
    storage: options.storage,
    contributionPipeline: options.contributionPipeline,
    clock: options.clock,
  });
  const authorityProvider = createAuthorityProvider({
    input,
    codingPorts,
    storage: options.storage,
  });
  const summarizationRunner = createContextSummarizationRunner({
    summarizer: createGatewaySummarizer(options.gateway),
  });
  const forcedPolicy = {
    targetRecentTailRatio: 0.12,
    targetRecentTailTokensCap: 4_096,
    minRecentTailRatio: 0.05,
    minRecentTailTokensCap: 1_024,
    sourceLimits: {
      [String(CODING_CONTEXT_SOURCE_IDS.relevantFiles)]: 4_096,
      [String(CODING_CONTEXT_SOURCE_IDS.projectMetadata)]: 1_024,
      "agent.memory": 1_024,
    },
  } as const;

  return createV2ContextEngine({
    sourceRegistry: sources,
    checkpointRepository: options.storage.contextCheckpointsV2,
    authorityProvider,
    usageStore: options.storage.contextUsage,
    compactionCommit: options.storage.contextCompactionCommit,
    notifier: options.notifier,
    compactionEvents: createContextCompactionEventFactory(),
    checkpointIdFactory: { create: () => `ctx_${String(createEventId())}` },
    eventIdFactory: { create: createEventId },
    clock: options.clock,
    forcedPolicy,
    requestOverheadEstimator: createContextRequestOverheadEstimator({ tokenEstimator }),
    historyIndexer: createContextHistoryIndexer(),
    documentBuilder: createContextDocumentBuilder(),
    rehydrator: createContextRehydrator(),
    materializer: createContextMaterializer({
      projectors: options.messageProjectors,
      tokenEstimator,
    }),
    receiptBuilder: createContextReceiptBuilder({
      now: options.clock.now,
      tokenEstimator,
    }),
    summarizationRunner,
  });
}

function createSourceRegistry(options: {
  readonly input: RunAgentContextEngineInput;
  readonly codingPorts: LocalCodingContextPorts;
  readonly tokenEstimator: ContextTokenEstimatorPort;
  readonly memoryRetriever: MemoryRetriever;
  readonly storage: CaelushStorage;
  readonly contributionPipeline: ContextContributionPipeline;
  readonly clock: { now(): TimestampMs };
}) {
  const builder = createContextSourceRegistryBuilder();
  const register = (
    provider: ContextSourceProvider,
    priority: number,
    criticality: ContextSourceRegistration["criticality"],
  ) => builder.register({ id: provider.id, priority, criticality, provider });
  register(
    createCorePolicyContextSourceProvider({ text: options.input.baseSystemPrompt }),
    0,
    "REQUIRED",
  );
  register(createConversationContextSourceProvider(), 10, "REQUIRED");
  register(
    createCheckpointContextSourceProvider({
      loader: {
        async load(input): Promise<ContextCheckpointProjection | undefined> {
          const checkpoint = await options.storage.contextCheckpointsV2.getLatestByRun(
            input.identity.runId,
          );
          if (checkpoint === undefined) return undefined;
          return {
            checkpointId: checkpoint.checkpointId,
            sourceRef: `checkpoint:${checkpoint.checkpointId}`,
            version: `checkpoint-v${String(checkpoint.schemaVersion)}`,
            checkpoint: checkpoint.structuredCheckpoint,
          };
        },
      },
    }),
    20,
    "REQUIRED",
  );
  register(
    createProjectInstructionContextSourceProvider({
      port: options.codingPorts.projectInstructions,
      tokenEstimator: options.tokenEstimator,
    }),
    30,
    "REQUIRED",
  );
  register(
    createWorkspaceContextSourceProvider({
      port: options.codingPorts.workspace,
      tokenEstimator: options.tokenEstimator,
    }),
    40,
    "REQUIRED",
  );
  register(
    createRuntimeFactsContextSourceProvider({
      port: options.codingPorts.runtimeFacts,
      tokenEstimator: options.tokenEstimator,
    }),
    50,
    "REQUIRED",
  );
  register(
    createVerificationRepairContextSourceProvider({
      ...(options.input.verificationRepairContext === undefined
        ? {}
        : {
            port: {
              async read() {
                return {
                  sourceRef: `verification-repair:${String(options.input.run.id)}`,
                  version: "run-verification-repair-v1",
                  repairRef: "current",
                  text: options.input.verificationRepairContext?.text ?? "",
                };
              },
            },
          }),
      tokenEstimator: options.tokenEstimator,
    }),
    60,
    "OPTIONAL",
  );
  register(
    createRelevantFileContextSourceProvider({
      port: options.codingPorts.relevantFiles,
      tokenEstimator: options.tokenEstimator,
    }),
    70,
    "OPTIONAL",
  );
  register(
    createProjectMetadataContextSourceProvider({
      port: options.codingPorts.projectMetadata,
      tokenEstimator: options.tokenEstimator,
    }),
    80,
    "OPTIONAL",
  );
  register(
    createMemoryContextSourceProvider({
      loader: {
        async load(input): Promise<readonly ContextMemoryProjection[]> {
          const records = await options.memoryRetriever.retrieve({
            scope: "PROJECT",
            projectId: options.input.run.workspace.id,
            goal: input.identity.goal,
            maxItems: 32,
            maxTokens: 4_096,
          });
          return records
            .filter((record) => record.sensitivity !== "SENSITIVE")
            .map((record) => {
              const text = redactText(`${record.topic}: ${record.fact}`);
              return {
                id: record.id,
                sourceRef: `memory:${record.id}`,
                version: "memory-v2",
                text,
                tokenEstimate: Math.max(
                  1,
                  Math.ceil(new TextEncoder().encode(text).byteLength / 3),
                ),
              };
            });
        },
      },
    }),
    90,
    "OPTIONAL",
  );
  register(
    createExtensionContributionContextSourceProvider({
      loader: {
        async load(input): Promise<readonly ContextContribution[]> {
          const result = await options.contributionPipeline.run(
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
              mode: options.input.runMode === "RECOVER" ? "RECOVER" : "EXECUTE",
              signal: input.signal,
            },
          );
          return result.contributions;
        },
      },
    }),
    100,
    "OPTIONAL",
  );
  register(createBranchContextSourceProvider(), 110, "OPTIONAL");
  register(
    createSkillCatalogContextSourceProvider({
      port: createNoOpSkillCatalogPort(),
      projectId: options.input.run.workspace.id,
      tokenEstimator: options.tokenEstimator,
    }),
    120,
    "OPTIONAL",
  );
  register(
    createGitStateContextSourceProvider({
      port: options.codingPorts.gitState,
      tokenEstimator: options.tokenEstimator,
    }),
    130,
    "OPTIONAL",
  );
  register(
    createTemporalContextSourceProvider({
      clock: options.clock,
      tokenEstimator: options.tokenEstimator,
    }),
    140,
    "OPTIONAL",
  );
  return builder.build();
}

function createAuthorityProvider(options: {
  readonly input: RunAgentContextEngineInput;
  readonly codingPorts: LocalCodingContextPorts;
  readonly storage: CaelushStorage;
}): ContextAuthorityProviderPort {
  return {
    async snapshot(input) {
      const [workspace, git, approvals, resources, plan, state] = await Promise.all([
        options.codingPorts.workspace.describe({ identity: input.identity, signal: input.signal }),
        options.codingPorts.gitState.read({ identity: input.identity, signal: input.signal }),
        options.storage.approvals.listPendingByRun(input.identity.runId),
        options.storage.resourceGovernance.get(input.identity.runId),
        options.storage.verification.getLatestPlan(input.identity.runId),
        options.storage.runStates.get(input.identity.runId),
      ]);
      const changedFiles = git.changedPaths.slice(0, 128);
      const pendingApprovals = approvals
        .slice(0, 64)
        .map((approval) => `${approval.id}:${approval.toolInvocationId}:${approval.riskLevel}`);
      const verificationState =
        plan === null
          ? "NO_VERIFICATION_PLAN"
          : `plan=${plan.id} checks=${plan.checks.map((check) => `${check.spec.kind}:${check.status}`).join(",")}`;
      const resourceGovernance =
        resources === null
          ? "NO_RESOURCE_STATE"
          : `${resources.mode}:${resources.resourceGuardState}:turns=${String(resources.agentTurnsConsumed)}:tools=${String(resources.toolOperationsConsumed)}`;
      return {
        goal: options.input.identity.goal,
        changedFiles,
        pendingApprovals,
        activeProcesses: (state?.activeProcesses ?? [])
          .slice(0, 64)
          .map((process) => `${process.id}:${process.status}:${process.command}`),
        verificationState,
        resourceGovernance,
        projectFacts: [
          `workspace=${workspace.workspaceId}`,
          `project=${workspace.projectId}`,
          `cwd=${workspace.cwdRef}`,
          `git=${git.summary}`,
        ],
      };
    },
  };
}

function createGatewaySummarizer(gateway: AIGateway): ContextSummarizerPort {
  return {
    async summarize(input: ContextSummarizationInput, options: { readonly signal: AbortSignal }) {
      const request: AIModelRequest = {
        model: input.model.ref,
        messages: [
          {
            role: "system",
            content:
              "Return exactly one JSON object matching the StructuredCheckpoint schema. Preserve durable facts, never invent tool effects, and keep every string concise.",
          },
          {
            role: "user",
            content: serializeContextSummarySource(input),
          },
        ],
      };
      const result = await gateway.complete(request, { signal: options.signal });
      return {
        checkpoint: createStructuredCheckpoint(parseCheckpoint(result.text)),
        modelRef: input.model.ref,
        summaryPromptVersion: 1,
        sourceDigest: "gateway-summary-source",
        checkpointDigest: "gateway-summary-checkpoint",
      };
    },
  };
}

function parseCheckpoint(text: string) {
  const trimmed = text.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const value: unknown = JSON.parse(withoutFence);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Context summary did not return a checkpoint object.");
  }
  return value as Parameters<typeof createStructuredCheckpoint>[0];
}
