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
    expect(composition).toMatch(/modelTurns[,:]/);
    // Verification reviews through the same executor, not through a second generation.
    expect(composition).toMatch(/verificationModelTurns:\s*modelTurns/);
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

  it("imports the legacy message contract from an explicit per-file allowlist only", async () => {
    // Message System V2 is out of scope for Phase 2C, so `@caelush/llm/messages` stays
    // legal for the frozen message schemas — but only in the files that actually own
    // history, continuations or conversations. A new file must be a deliberate decision.
    //
    // Phase 3A moved the decision contract into `@caelush/agent`, so `agent-decision.ts` no
    // longer imports the legacy message type, and it was removed from the list rather than left
    // as a stale entry. Phase 3B added the Core compatibility context boundary, which projects
    // between the frozen AI messages and the still-legacy durable conversation.
    const allowlist = [
      "packages/core/src/agent-continuation-schema.ts",
      "packages/core/src/agent-continuation.ts",
      "packages/core/src/agent-loop-history.ts",
      "packages/core/src/agent-loop-input.ts",
      "packages/core/src/agent-loop.ts",
      "packages/core/src/agent-tool-batch.ts",
      "packages/core/src/agent-tool-results.ts",
      "packages/core/src/ai-invocation-projection.ts",
      "packages/core/src/legacy-context-runtime-adapter.ts",
      "packages/core/src/run-controller-history.ts",
      "packages/core/src/run-controller-input.ts",
      "packages/core/src/run-controller-ports.ts",
      "packages/core/src/run-controller.ts",
      // Phase 3C made the Run execution snapshot agent-owned. The legacy durable encoding is
      // projected in exactly one reviewed codec, and nowhere else in the Run Layer:
      // `run-message-compatibility.ts` for messages, `run-continuation-compatibility.ts` for
      // the continuations that carry them. Storage implements the port and calls the codec
      // rather than naming the AI contract itself.
      "packages/core/src/run-message-compatibility.ts",
    ];

    const files = await scan("packages/core/src");
    const actual = files
      .filter(({ source }) => source.includes('"@caelush/llm/messages"'))
      .map(({ file }) => file)
      .sort();

    expect(actual).toEqual([...allowlist].sort());
  });

  it("names the model execution seam through the AI contract and the agent facade", async () => {
    const ports = await read("packages/core/src/agent-loop-ports.ts");
    expect(ports).toContain('from "@caelush/ai"');
    // Phase 3A aligned the agent executor with the frozen union result, so the Core loop
    // now consumes the transitional throw-based facade over it rather than the frozen port
    // itself. The agent package keeps no throw-based public interface.
    expect(ports).toMatch(/readonly modelTurns:\s*LegacyModelTurnExecutor/);
    const facade = await read("packages/core/src/legacy-model-turn-executor.ts");
    expect(facade).toContain('from "@caelush/agent"');
    expect(ports).toMatch(/readonly models:\s*ModelCatalog/);
    expect(ports).not.toMatch(/\bllmClient\b/);
  });
});

describe("Phase 2C Context model metadata authority", () => {
  it("projects intrinsic limits from a descriptor instead of resolving a second profile", async () => {
    const coordinator = await read("packages/context/src/context-runtime-coordinator.ts");

    // The descriptor path is the authority...
    expect(coordinator).toContain("projectModelContextProfile");
    // ...and the legacacy resolver is reachable only when the caller supplied no
    // descriptor, which is the one compatibility case Phase 2C keeps.
    const resolveCalls = coordinator.match(/resolveModelContextProfile\(/g) ?? [];
    expect(resolveCalls).toHaveLength(1);
    expect(coordinator).toMatch(
      /input\.model === undefined \? undefined : this\.#compatibilityProfile\(input\)/,
    );
  });

  it("keeps the policy fields out of the descriptor projection", async () => {
    const profile = await read("packages/context/src/model-context-profile.ts");
    const projection = profile.slice(profile.indexOf("export function projectModelContextProfile"));

    // The intrinsic fields come from the descriptor...
    expect(projection).toContain("descriptor.limits.contextWindowTokens");
    expect(projection).toContain("descriptor.limits.maxOutputTokens");
    // ...and the policy fields come from the caller, never from the descriptor.
    expect(projection).toContain("input.recommendedOutputReserveTokens");
    expect(projection).not.toContain("descriptor.recommendedOutputReserveTokens");
    expect(projection).not.toContain("descriptor.toolOutputSoftLimitTokens");
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
        if (specifier !== "@caelush/ai" && specifier !== "@caelush/protocol") {
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
    expect(caelushSpecifiers(entry)).toEqual([]);
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
        "agentTurnInputErrorMessage",
        // `ALLOWED_MODEL_ADMISSION` was a frozen constant while ALLOWED carried only `kind`.
        // The frozen decision carries the approved request, so a shared constant cannot express
        // it: the factory replaces the constant at the same single-authority position.
        "allowedModelAdmission",
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
        "completeAgentStep",
        "createAgentDecisionClassifier",
        "createAgentLoop",
        "createAgentTurnRef",
        "createModelRequestBuilder",
        "createModelTurnExecutor",
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
      ].sort(),
    );
  });
});
