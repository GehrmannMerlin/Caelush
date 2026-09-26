import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture V2 Phase 2C model authority guards.
 *
 * Phase 2C converges model invocation onto one authority chain:
 *
 * ```text
 * ModelCatalog → ModelDescriptor → Context / AIGateway → ModelTurnExecutor → AgentLoop
 * ```
 *
 * These guards are deliberately *structural*: they read production source and fail when a
 * legacy authority identifier, a forbidden package edge, or a second routing input
 * reappears. They are additive to `scripts/architecture/v2-rules.mjs` and never replace
 * the boundary checker.
 */

const REPO_ROOT = process.cwd();

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const absolute = path.resolve(REPO_ROOT, directory);
  const out: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(relative)));
    else if (entry.name.endsWith(".ts")) out.push(relative.replaceAll("\\", "/"));
  }
  return out;
}

async function read(file: string): Promise<string> {
  return (await readFile(path.resolve(REPO_ROOT, file), "utf8")).replace(/\r\n/g, "\n");
}

/** `"a"` and `'a'` are the same specifier. */
function caelushSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/from\s+["'](@caelush\/[^"']+)["']/g)].map((match) => match[1] ?? "");
}

async function scan(
  directory: string,
): Promise<readonly { readonly file: string; readonly source: string }[]> {
  const files = await sourceFiles(directory);
  return Promise.all(files.map(async (file) => ({ file, source: await read(file) })));
}

describe("Phase 2C daemon model authority", () => {
  it("composes the AI subsystem and never a legacy gateway or provider registry", async () => {
    const files = await scan("apps/daemon/src");
    const offenders: string[] = [];

    for (const { file, source } of files) {
      if (/\b(?:LLMGateway|LLMProviderRegistry|createOpenAICompatibleLLMProvider)\b/.test(source)) {
        offenders.push(`${file}: legacy model authority identifier`);
      }
      if (caelushSpecifiers(source).includes("@caelush/llm")) {
        offenders.push(`${file}: imports the legacy LLM package root`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("builds the AgentLoop from the catalog and the model turn executor", async () => {
    const composition = await read("apps/daemon/src/daemon-composition.ts");
    expect(composition).toContain("createAISubsystem(");
    expect(composition).toContain("createModelTurnExecutor(");
    // The loop resolves model metadata through the same catalog generation the gateway
    // uses, so there is exactly one descriptor authority.
    expect(composition).toMatch(/models:\s*ai\.models/);
    // A host-driven turn is executed by the one executor, under the identity its caller names.
    expect(composition).toMatch(/verificationModelTurns:\s*VerificationModelClient/);
    expect(composition).toContain("modelTurnExecutor.execute({");
    // Verification reviews through the same executor, not through a second generation: Phase 3E
    // retired the throw-based facade, so the explicit-identity client *is* the executor wrapper.
    expect(composition).toMatch(/const verificationModelTurns: VerificationModelClient = \{/);
    expect(composition).toContain("verificationModelTurns,");
    expect(composition).not.toContain("createLegacyModelTurnExecutor(");
  });
});

describe("Phase 2C Core model authority", () => {
  it("never reaches a model through the legacy LLM abstraction", async () => {
    const files = await scan("packages/core/src");
    const offenders: string[] = [];

    for (const { file, source } of files) {
      if (/\b(?:LLMGateway|LLMProviderRegistry|LLMProvider|LLMStreamEvent)\b/.test(source)) {
        offenders.push(`${file}: legacy model authority identifier`);
      }
      if (caelushSpecifiers(source).includes("@caelush/llm")) {
        offenders.push(`${file}: imports the legacy LLM package root`);
      }
      if (/from\s+["']@caelush\/llm\/(?:errors|request|providers)["']/.test(source)) {
        offenders.push(`${file}: imports a legacy model-invocation subpath`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no legacy model-message imports after the Phase 5F retirement", async () => {
    const files = await scan("packages/core/src");
    const actual = files
      .filter(({ source }) => source.includes("@caelush/llm"))
      .map(({ file }) => file)
      .sort();

    expect(actual).toEqual([]);
  });

  it("names the model execution seam through the AI contract and the agent facade", async () => {
    const ports = await read("packages/core/src/run-agent-execution.ts");
    expect(ports).toContain('from "@caelush/ai"');
    expect(ports).toMatch(/readonly modelTurnExecutor:\s*ModelTurnExecutor/);
    expect(ports).toContain('from "@caelush/agent"');
    expect(ports).toMatch(/readonly models:\s*ModelCatalog/);
    expect(ports).not.toMatch(/\bllmClient\b/);
  });
});

describe("Phase 2C Context model metadata authority", () => {
  it("projects intrinsic limits from the Agent model descriptor", async () => {
    const policy = await read("packages/agent/src/context/policy/context-policy.ts");
    expect(policy).toContain("input.model.limits.contextWindowTokens");
    expect(policy).toContain("input.model.limits.maxOutputTokens");
    expect(policy).not.toContain("resolveModelContextProfile");
  });

  it("keeps policy fields as caller options rather than descriptor fields", async () => {
    const policy = await read("packages/agent/src/context/policy/context-policy.ts");
    expect(policy).toContain("readonly outputReserveTokens?: number");
    expect(policy).toContain("options.outputReserveTokens");
    expect(policy).not.toContain("descriptor.recommendedOutputReserveTokens");
    expect(policy).not.toContain("descriptor.toolOutputSoftLimitTokens");
  });
});

describe("Phase 2C endpoint authority", () => {
  it("never reattaches a stored baseUrl to a model selection", async () => {
    const files = await scan("apps/daemon/src");
    const offenders: string[] = [];

    for (const { file, source } of files) {
      // A spread that puts `baseUrl` back onto a selection would restore a second
      // routing input next to the provider binding.
      if (/\{\s*\.\.\.\s*[A-Za-z_$][\w$]*\s*,\s*baseUrl\s*:/.test(source)) {
        offenders.push(`${file}: reintroduces baseUrl into a model selection`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the daemon model canonicalizer free of endpoint data in its output", async () => {
    const canonicalizer = await read("apps/daemon/src/providers/model-canonicalizer.ts");
    // Comments explain the removed behaviour; only executable code is guarded.
    const code = canonicalizer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // The legacy configuration DTO is the only thing that may name an endpoint: it is
    // the operator's input, not a model identity.
    expect(code).toMatch(/readonly baseUrl: string;/);
    // No result object may carry one back out.
    expect(code).not.toMatch(/baseUrl\s*[,}]/);
    expect(code).not.toMatch(/\.\.\.[^;]*baseUrl/);
  });
});

describe("Phase 2C package edges", () => {
  it("keeps Storage free of the AI core", async () => {
    const files = await scan("packages/storage/src");
    const offenders = files
      .filter(({ source }) => caelushSpecifiers(source).includes("@caelush/ai"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps the Agent kernel package on its two target dependencies only", async () => {
    const files = await scan("packages/agent/src");
    const offenders: string[] = [];
    for (const { file, source } of files) {
      for (const specifier of caelushSpecifiers(source)) {
        // Phase 3A widened the frozen kernel contract to `@caelush/protocol` as well:
        // identity is Protocol `RunId`/`SessionId`/`StepId` and durable tool identity is the
        // Protocol `ToolName` and `JsonObject`. Both are target packages, and every legacy
        // package stays forbidden.
        //
        // A file naming `@caelush/agent` from inside `@caelush/agent` is not a workspace edge: it
        // resolves to this package itself, which is why the architecture checker excludes it from the
        // dependency graph. The guard states the exclusion rather than treating the observation as a
        // violation.
        if (
          specifier !== "@caelush/ai" &&
          specifier !== "@caelush/protocol" &&
          specifier !== "@caelush/agent"
        ) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the Agent kernel surface root-only, cross-package-free and deliberate", async () => {
    const entry = await read("packages/agent/src/index.ts");
    // No cross-package re-export and no wildcard: a consumer imports from `@caelush/agent`
    // and never from a deep path.
    expect(
      caelushSpecifiers(entry).filter((specifier) => specifier !== "@caelush/protocol"),
    ).toEqual([]);
    expect(entry).not.toMatch(/export \* from/);
    const exported = [...entry.matchAll(/export \{([^}]*)\}/g)].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    );
    // Phase 3A froze the V2 kernel contracts, Phase 3B implemented `advance()` and the context
    // boundary, and Phase 3C froze the durable Run execution decision and moved the Run execution
    // store, continuation domain and Step lifecycle into the kernel's Run Layer. The list is
    // asserted exactly so it can never widen by accident, and each name here is a frozen contract
    // of Architecture V2 Phase 3.
    expect(exported.sort()).toEqual(
      [
        "AGENT_DECISION_TYPES",
        "AGENT_LOOP_ADVANCE_RESULT_KINDS",
        "AGENT_TRANSIENT_STREAM_EVENT_TYPES",
        "AGENT_TURN_INPUT_ERROR_REASONS",
        "AgentModelOutputError",
        // The general turn-input and conversation validation domain, and the canonical Step
        // lifecycle. They live in the kernel because each is a protocol statement about a message
        // or a Step, and a host that reimplemented one would be a second authority over it.
        "AgentStepStateError",
        "AgentTurnInputError",
        // Phase 7A/7B publish the parallel Context Kernel foundation from the Agent root.
        "ContextCurrentTurnTooLargeError",
        "ContextExhaustedError",
        "ContextDocumentConstructionError",
        "ContextMandatoryInputTooLargeError",
        "ContextPlanningError",
        "ContextSourceCollectionError",
        "Utf8HeuristicTokenEstimator",
        "CONTEXT_COMPACTION_REASONS",
        "assertStructuredCheckpoint",
        "createContextCheckpointId",
        "createContextCompactionEventFactory",
        "createContextCompactionPlanner",
        "createContextMaterializer",
        "createContextMessageRange",
        "createContextRehydrator",
        "createContextSummarizationRunner",
        "createContextSummaryPromptVersion",
        "createStructuredCheckpoint",
        "prepareContextCompactionCandidates",
        "serializeContextSummarySource",
        // Phase 7C publishes the generic Source Provider contracts and factories from the
        // Agent root. The coding overlay remains in @caelush/coding-agent; these are only the
        // provider-neutral source IDs, projections, and adapters.
        "AGENT_CONTEXT_SOURCE_IDS",
        "assertContextFingerprint",
        "assertContextItem",
        "assertContextPlan",
        "assertContextRequestOverhead",
        "assertContextSourceResult",
        "collectContextSources",
        "createContextArtifactId",
        "buildContextFingerprint",
        "createContextDocumentBuilder",
        "createContextFingerprint",
        "createContextHistoryIndexer",
        "createContextItem",
        "createContextItemId",
        "createContextPlanner",
        "createContextPolicy",
        "createContextRequestOverheadEstimator",
        "createContextReceiptBuilder",
        "createContextSourceId",
        "createContextSourceItem",
        "createContextSourceRegistryBuilder",
        "createConversationContextSourceProvider",
        "createCheckpointContextSourceProvider",
        "createCorePolicyContextSourceProvider",
        "createExtensionContributionContextSourceProvider",
        "createMemoryContextSourceProvider",
        "createBranchContextSourceProvider",
        "createUtf8HeuristicTokenEstimator",
        "freezeContextSourceResult",
        "planContext",
        // Phase 6F: the generic Control Hook runner and bounded Context Contribution pipeline are
        // public Agent contracts; their concrete Context projection remains outside this package.
        "ContextContributionPipelineError",
        "ControlHookAbortedError",
        "ControlHookConfigurationError",
        "ControlHookPipelineError",
        "ControlHookReentrancyError",
        "ControlHookTimeoutError",
        "DEFAULT_CONTEXT_CONTRIBUTION_LIMITS",
        // --- Phase 3C Checkpoint 4: the canonical Run state machine and the general Run/AgentState
        // transitions moved into the kernel, and the pure Run transition planner was implemented
        // there. Each of these is one declaration: Core re-exports them rather than redeclaring
        // them, so a host cannot become a second authority over a Run's lifecycle.
        "DefaultRunTransitionPlanner",
        "InvalidRunStatusTransitionError",
        "RUN_STATUSES",
        "RUN_STATUS_TRANSITIONS",
        "assertMonotonicAgentStateTimestamp",
        "assertRunStatusTransition",
        "assertRunStatusTransitionsAreTotal",
        "canTransitionRunStatus",
        "cancelAgentRun",
        "completeAgentRunWithFinalResult",
        "completeAgentState",
        "createRunTransitionPlanner",
        "failAgentRun",
        "markAgentRunBudgetExceeded",
        "markAgentRunMaxStepsReached",
        "markAgentRunWaitingApproval",
        "markAgentRunWaitingResource",
        "markAgentStateBudgetExceeded",
        "markAgentStateCancelled",
        "markAgentStateFailed",
        "markAgentStateMaxStepsReached",
        "markAgentStateTimedOut",
        "markAgentStateVerifying",
        "markAgentStateWaitingApproval",
        "markAgentStateWaitingResource",
        "planRunTransition",
        "resumeAgentRunFromApproval",
        "resumeAgentRunFromCompletionRepair",
        "resumeAgentRunFromResource",
        "resumeAgentStateFromApproval",
        "resumeAgentStateFromResource",
        "timeOutAgentRun",
        // Phase 3C restored the frozen completion contract: the four decisions are discriminated
        // by `kind`, so the closed-set constant is named for the discriminant it enumerates.
        "COMPLETION_GATE_KINDS",
        // Phase 3F added the general gate implementation the frozen contract always named: a host with
        // no verification subsystem composes it, and a coding host must never.
        "DIRECT_ACCEPT_COMPLETION_GATE_ID",
        "MODEL_TURN_EXECUTION_ERROR_CODES",
        "RETRYABLE_MODEL_TURN_ERROR_CODES",
        "RUNNING_CONTINUATION_TYPES",
        "RUN_CONTINUATION_TYPES",
        "RUN_EXECUTION_ADVANCE_REASONS",
        "RUN_EXECUTION_DIRECTIVE_KINDS",
        "RUN_EXECUTION_EFFECT_KINDS",
        "RUN_EXECUTION_FINALIZE_REASONS",
        "RUN_EXECUTION_STATUSES",
        "RUN_EXECUTION_SUSPEND_BOUNDARIES",
        "RunExecutionConflictError",
        "RunExecutionInvariantError",
        "TOOL_TURN_RESULT_KINDS",
        // --- Phase 4D: the canonical Tool batch, its two error classes, and the model-facing Tool
        // result exit. Each is one declaration in the kernel, because the batch scheduler, the
        // pre-invocation rejection vocabulary, the result-batch integrity defense and the model
        // feedback projection are general Agent capabilities rather than Coding ones. Core re-exports
        // the error classes instead of redeclaring them, so `instanceof` cannot disagree.
        "AgentToolResultBatchError",
        "MODEL_FEEDBACK_TRUNCATION_MARKER",
        "SKIPPED_AFTER_UNCERTAIN_CONTENT",
        "SKIPPED_AFTER_UNCERTAIN_EXECUTION",
        "TOOL_BATCH_ITEM_OUTCOME_KINDS",
        "TOOL_BATCH_OUTCOME_KINDS",
        "ToolBatchInfrastructureError",
        "ToolBatchInputError",
        "createModelToolFeedbackProjector",
        "createToolBatchCoordinator",
        "createToolResultBatchNormalizer",
        "createToolObservationBatchProjector",
        "agentTurnInputErrorMessage",
        // `ALLOWED_MODEL_ADMISSION` was a frozen constant while ALLOWED carried only `kind`.
        // The frozen decision carries the approved request, so a shared constant cannot express
        // it: the factory replaces the constant at the same single-authority position.
        "allowedModelAdmission",
        "createDirectAcceptCompletionGate",
        "assertAgentTurnInput",
        "assertAgentTurnRef",
        "assertConversationProtocolIntegrity",
        "assertPendingAssistantHistory",
        // Phase 3C froze one declaration of the Run execution invariant, in the kernel: a host
        // that re-declared it would be a second authority over what a Run execution is.
        "assertRunExecutionInvariant",
        "beginAgentStepState",
        "cancelAgentStep",
        "cancelAgentStepState",
        "classifyAgentDecision",
        "classifyContextPressure",
        "completeAgentStep",
        "createAgentDecisionClassifier",
        "createAgentLoop",
        "createAgentTurnRef",
        "createContextContributionPipeline",
        "createControlHookId",
        "createControlHookRegistryBuilder",
        "createControlHookRunner",
        "createModelRequestBuilder",
        // Phase 6E: the Agent-side projector is the only bridge from public AI deltas to the
        // canonical transient Protocol domain; identity and time remain injected ports.
        "createModelStreamSignalProjector",
        "createModelTurnExecutor",
        "createV2ContextEngine",
        "createRunExecutionCoordinator",
        "createRunExecutionDriver",
        "createRunningAgentStep",
        "failAgentStep",
        "isRetryableModelTurnErrorCode",
        "isRunningContinuation",
        "isTerminalExecutionStatus",
        // The terminal-Run predicate moves with the invariant it belongs to, so a host cannot
        // disagree with the kernel about which statuses end a Run.
        "isTerminalRunStatus",
        "nextAgentStepSequence",
        "nextRunExecutionDirective",
        "semanticEqual",
        "settleAgentStepState",
        "toAIModelSettings",
        "toAgentError",
        "toAgentErrorCode",
        "toAgentTurnInputError",
        "toBudgetAgentError",
        "toModelTurnExecutionError",
        "toModelTurnExecutionErrorCode",
        // --- Phase 4A: the general Agent Tool framework. Tool System V2 splits one Tool definition
        // into three layers, and this package owns the first two — the executable `AgentTool`
        // contract and the `AIToolSpec` projection it extends. The canonical schema runtime and
        // policy, the immutable ordered registry and the call Preparer moved here with it, so a host
        // can register an in-memory Tool, build a registry, project its model specs and prepare a
        // call with no Coding, Runtime or Storage implementation involved. The Coding overlay
        // (`CodingToolDefinition` / `CodingToolCatalog`) lives in `@caelush/coding-agent` and consumes
        // exactly these contracts.
        "AgentToolRegistrationError",
        "AgentToolRegistryStateError",
        "AgentToolSchemaCompileError",
        "DEFAULT_MAX_EXTERNAL_CALL_ID_BYTES",
        "DEFAULT_MAX_INVOCATION_ARGS_BYTES",
        "DEFAULT_TOOL_EXECUTION_MODE",
        "DEFAULT_TOOL_REGISTRY_OPTIONS",
        "DISCARDING_TOOL_EXECUTION_UPDATE_SINK",
        "DefaultAgentToolRegistryBuilder",
        "ImmutableAgentToolRegistry",
        "TOOL_CALL_REJECTION_CODES",
        "TOOL_EXECUTION_MODES",
        "ToolArgumentPreparationError",
        "ToolExecutionInfrastructureError",
        "ToolPreparationInfrastructureError",
        "ToolSchemaRuntime",
        "canonicalJsonString",
        "canonicalizeJsonValue",
        "cloneJsonValue",
        "containsForbiddenSchemaFeature",
        "createToolCallPreparer",
        "deepFreezeJson",
        "isJsonObject",
        "isToolExecutionMode",
        "jsonUtf8ByteLength",
        "normalizeInstancePath",
        "toolModelSpecByteLength",
        "validateToolRegistryOptions",
        "validateToolSchemaSemantics",
        // --- Phase 4B: Tool execution and result processing. The kernel now owns invoking an
        // already-durably-started Tool through its canonical `AgentTool`, the safe transient update
        // lifecycle, and the `validate -> sanitize -> revalidate -> bound -> project` result pipeline
        // with its frozen limits, sanitizer port and opaque settlement extension. The canonical
        // uncertainty vocabulary lives here too, so a Tool that throws it is recognized structurally
        // rather than by inspecting an error message.
        "CODING_TOOL_EFFECTS_EXTENSION_KIND",
        "DEFAULT_TOOL_RESULT_LIMITS",
        "DISCARDING_TRANSIENT_TOOL_UPDATE_CONSUMER",
        "IDENTITY_TOOL_RESULT_SANITIZER",
        "TOOL_RESULT_TRUNCATION_MARKER",
        "ToolExecutionUncertainError",
        "ToolResultLimitError",
        "ToolResultValidationError",
        "UNCERTAIN_SIDE_EFFECT",
        "boundToolResultContent",
        "createToolInvocationExecutor",
        "createToolResultPipeline",
        "isAgentToolResult",
        "isToolExecutionUncertainError",
        "readResultShape",
        "readSanitizedResultShape",
        "uncertainExecutionDetails",
        "validateToolResult",
        "validateToolResultLimits",
        // --- Phase 4C: admission, the durable lifecycle and its atomic settlement.
        //
        // The kernel now owns the Tool Invocation Lifecycle Authority. `DurableToolExecutionCoordinator`
        // drives idempotency, the durable `REQUESTED`/`RUNNING` checkpoints, admission, execution,
        // result processing and terminal settlement; `ToolAdmissionCoordinator` owns policy, approval
        // and budget admission; `ToolSettlementCoordinator` owns the terminal commit. The store
        // contract, the lifecycle, the observation and the durable error identity are shipped with
        // them, because the layer that commits a row is the layer that must state its shape.
        "DEFAULT_TOOL_APPROVAL_SCOPE",
        "DURABLE_FAILURE_CODES",
        "ToolCallBusyError",
        "ToolDurableMetadataUnavailableError",
        "ToolExecutionAbortedError",
        "ToolExecutionConflictError",
        "ToolExecutionInvariantError",
        "ToolSecurityContextError",
        "UNBOUNDED_TOOL_BUDGET_ADMISSION",
        "allowedToolInvocationTransitions",
        "assertToolInvocationInvariant",
        "assertToolInvocationTransition",
        "assertToolObservationInvariant",
        "assertToolSecurityContext",
        "completeToolInvocation",
        "createApprovalRequestedEvent",
        "createApprovalResolvedEvent",
        "createDurableToolExecutionCoordinator",
        "createRequestedToolInvocation",
        "createToolAdmissionCoordinator",
        "createToolCompletedEvent",
        "createToolFailedEvent",
        "createToolFailureSettlement",
        "createToolObservation",
        "createToolOutputEvent",
        "createToolRequestedEvent",
        "createToolSettlementCoordinator",
        "createToolStartedEvent",
        "denyToolPolicyDecision",
        "failToolInvocation",
        "feedbackToDurableFailure",
        "isTerminalToolInvocation",
        "isToolSecurityContext",
        "markToolInvocationWaitingApproval",
        "requireToolDurableMetadata",
        "startToolInvocation",
        "MAX_TOOL_EVENT_PRESENTATION_BYTES",
        // Phase 6A/6D: durable event drafts are constructed here and committed by the Run layer.
        "createRunEventFactory",
        // --- Phase 5A: the Message Domain. The kernel now owns the conversation language, its
        // identity and audience, the Message Factory, the durable record contracts, the versioned
        // codec registry, the versioned model-projection registry, the Conversation Validator, the
        // ExecutionUnit and the projected ConversationSelector. Every one of them is a statement
        // about what a conversation *is*, so a host that reimplemented one would be a second
        // authority over the same question — which is exactly why they belong to the kernel rather
        // than to a host or to storage.
        //
        // The list stays asserted exactly, so it can still never widen by accident; this is the
        // recorded growth of one phase, not a relaxation of the rule.
        "AGENT_ASSISTANT_MESSAGE_AUDIENCE",
        "AGENT_ASSISTANT_MESSAGE_CODEC_V1",
        "AGENT_ASSISTANT_MESSAGE_PROJECTOR_V1",
        "AGENT_ATTACHMENT_MARKER_VERSION",
        "AGENT_CONTENT_PART_TYPES",
        "AGENT_CONVERSATION_VIOLATION_REASONS",
        "AGENT_LEGACY_ROLES",
        "AGENT_MESSAGE_AUDIENCE_FIELDS",
        "AGENT_MESSAGE_CODEC_ERROR_REASONS",
        "AGENT_MESSAGE_ID_PREFIX",
        "AGENT_MESSAGE_PROJECTION_ERROR_CODES",
        "AGENT_MESSAGE_SOURCE_KINDS",
        "AGENT_MESSAGE_TYPES",
        "AGENT_TOOL_RESULT_MESSAGE_AUDIENCE",
        "AGENT_TOOL_RESULT_MESSAGE_CODEC_V1",
        "AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1",
        "AGENT_USER_MESSAGE_AUDIENCE",
        "AGENT_USER_MESSAGE_CODEC_V1",
        "AGENT_USER_MESSAGE_ORIGINS",
        "AGENT_USER_MESSAGE_PROJECTOR_V1",
        "AgentConversationError",
        "AgentMessageCodecError",
        "AgentMessageCodecRegistryError",
        "AgentMessageProjectionError",
        "CONVERSATION_TURN_ID_PREFIX",
        "CONVERSATION_TURN_STATUSES",
        "DefaultAgentMessageCodecRegistryBuilder",
        "EMPTY_AGENT_MESSAGE_AI_PROJECTION",
        "OPAQUE_AGENT_MESSAGE_REASONS",
        "STANDARD_AGENT_MESSAGE_CODECS",
        "STANDARD_AGENT_MESSAGE_PROJECTION_VERSIONS",
        "STANDARD_AGENT_MESSAGE_PROJECTORS",
        "STRUCTURAL_TOKEN_ESTIMATOR",
        "TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION",
        "agentAssistantTextPart",
        "agentAssistantToolCallPart",
        "agentAttachmentRefPart",
        "agentConversationErrorMessage",
        "agentMessageCodecErrorMessage",
        "agentMessageCodecRegistryErrorMessage",
        "agentMessageId",
        "agentMessageProjectionErrorMessage",
        "agentMessageType",
        "agentTextPart",
        "assertAgentAssistantContent",
        "assertAgentMessageAudience",
        "assertAgentMessageProjectionVersion",
        "assertAgentMessageSchemaVersion",
        "assertAgentMessageSequence",
        "assertAgentMessageSource",
        "assertAgentUserContent",
        "assertJsonSafePayload",
        "assertProjectionFingerprint",
        "assistantToolCalls",
        "attachmentMarker",
        "buildConversationExecutionUnits",
        "buildExecutionUnits",
        "canonicalJsonText",
        "canonicalize",
        "conversationTurnId",
        "conversationTurnStatus",
        "createAgentAssistantMessage",
        "createAgentConversationSnapshot",
        "createAgentConversationValidator",
        "createAgentMessageAIProjection",
        "createAgentMessageBase",
        "createAgentMessageCodecRegistry",
        "createAgentMessageCodecRegistryBuilder",
        "createAgentMessageFactory",
        "createAgentMessageIdFactory",
        "createAgentMessageProjectorRegistry",
        "createAgentToolResultMessage",
        "createAgentUserMessage",
        "createConversationSelector",
        "createConversationTurn",
        "createConversationTurnIdFactory",
        "createDeterministicConversationTurnIdFactory",
        "createScriptedAgentMessageIdFactory",
        "createSeededConversationTurnIdFactory",
        "createSingleTurnConversationSnapshot",
        "createStandardAgentMessageCodecRegistry",
        "createStandardAgentMessageProjectorRegistry",
        "digestJsonObject",
        "digestJsonValue",
        "executionUnitId",
        "fingerprintProjection",
        "isAgentMessageId",
        "isCompactionCandidate",
        "isConversationTurnId",
        "isMeaningfulAttachmentRefPart",
        "isMeaningfulTextPart",
        "isValidProjectedConversation",
        "legacyMessageSource",
        "modelMessageSource",
        "projectStoredMessages",
        "projectionVersionTable",
        "toolMessageSource",
        "userMessageSource",
        // --- Phase 5B: the Message Interface Freeze Errata, applied. The Tool Result provenance
        // contracts now distinguish feedback that has a real execution behind it from feedback that
        // does not, and a known projection policy from one a legacy row never recorded. The Tool
        // System genuinely produces both kinds — a rejected call and a skipped trailing call reach
        // the model as feedback with no observation — so the older single-shape contract could not
        // represent what the runtime actually does. The list stays asserted exactly.
        "LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY",
        "NO_TOOL_RESULT_OBSERVATION",
        "TOOL_FEEDBACK_PROJECTION_POLICY_KINDS",
        "TOOL_MESSAGE_SOURCE",
        "TOOL_RESULT_OBSERVATION_REF_KINDS",
        "assertToolFeedbackProjectionPolicy",
        "assertToolResultObservationRef",
        "hasToolResultObservation",
        "toolFeedbackPolicySnapshot",
        "toolResultObservation",
        "toolResultObservationId",
        "AGENT_ASSISTANT_MESSAGE_TRANSCRIPT_PROJECTOR",
        "AGENT_TOOL_RESULT_MESSAGE_TRANSCRIPT_PROJECTOR",
        "AGENT_USER_MESSAGE_TRANSCRIPT_PROJECTOR",
        "STANDARD_AGENT_MESSAGE_TRANSCRIPT_PROJECTORS",
        "createAgentMessageTranscriptProjectorRegistry",
        "createStandardAgentMessageTranscriptProjectorRegistry",
        "unsupportedHistoricalTranscriptEntry",
        // --- Phase 5B: the durable storage contracts and the migration identity. The kernel now owns
        // the record store port and the conversation repository the storage layer implements, the
        // deterministic identity a legacy backfill derives, and the JSON-safe projection receipt mirror
        // that lets a receipt travel inside a durable record payload.
        "AgentConversationLoadError",
        "agentConversationLoadFailureMessage",
        "createAgentConversationRepository",
        "deriveLegacyAgentMessageId",
        "toToolFeedbackProjectionPolicyJson",
        "toToolFeedbackProjectionReceiptJson",
      ].sort(),
    );
  });
});
