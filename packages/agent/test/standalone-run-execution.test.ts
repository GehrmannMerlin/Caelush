import { describe, expect, it } from "vitest";
import type {
  AIGateway,
  AIStream,
  AIStreamEvent,
  AIModelTurnResult,
  ModelDescriptor,
} from "@caelush/ai";
import {
  agentMessageId,
  conversationTurnId,
  createAgentDecisionClassifier,
  createAgentConversationSnapshot,
  createAgentLoop,
  createAgentTurnRef,
  createDirectAcceptCompletionGate,
  createModelTurnExecutor,
  createRunExecutionDriver,
  DIRECT_ACCEPT_COMPLETION_GATE_ID,
  type AgentExecutionIdentity,
  type AgentLoopAdvanceInput,
  type CompletionGate,
  type CompletionGateInput,
  type ContextBuildReport,
  type ContextEnginePort,
  type ContextPrepareInput,
  type ModelTurnExecutor,
  type PreparedModelContext,
  type RunExecutionEffectContext,
  type RunExecutionEffectResult,
  type ToolObservationPolicySnapshot,
  type ToolTurnCoordinator,
  type ToolTurnRequest,
} from "@caelush/agent";
import { createRunId, createSessionId, createStepId, type StepId } from "@caelush/protocol";

/**
 * The General Agent's whole execution chain, standalone.
 *
 * ```text
 * USER_INPUT → TOOL_REQUESTS → the Driver calls an external echo ToolTurn
 *            → TOOL_RESULTS  → FINAL_CANDIDATE → the Driver calls the CompletionGate → ACCEPT
 * ```
 *
 * This file imports exactly one workspace package — `@caelush/agent` — plus the ID factories the host
 * needs to name a turn. There is no `@caelush/core`, no Storage, no SQLite, no Runtime, no Workspace,
 * no Git, no coding verification, no legacy Context or Tool package and no daemon anywhere in it.
 * `@caelush/protocol` types arrive only as the kernel's own contract types.
 *
 * The difference from `standalone-kernel.test.ts` is the point of the file: that test proves the
 * *Reason* kernel runs alone, this one proves the whole frozen Run execution contract does. The same
 * real `AgentLoop`, the same real `ModelTurnExecutor`, the same real `RunExecutionDriver` and the same
 * real `RunExecutionCoordinator` the production daemon drives — with the coding gate swapped for the
 * general one and the durable Tool System swapped for an echo adapter this file owns.
 *
 * Nothing here is a stub of the chain under test. The Tool adapter is a real implementation of the
 * frozen `ToolTurnCoordinator` port, and the gate is a real implementation of the frozen
 * `CompletionGate` port; the chain is what assembles them.
 */

const IDENTITY: AgentExecutionIdentity = {
  runId: createRunId(),
  sessionId: createSessionId(),
  goal: "echo the input back",
};

const CONVERSATION = createAgentConversationSnapshot({
  sessionId: IDENTITY.sessionId,
  currentRunId: IDENTITY.runId,
  currentTurnId: conversationTurnId("cturn_run_fixture"),
  turns: [],
});
const USER_MESSAGE_ID = agentMessageId("run-user");

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "fixture-model" },
  api: "fixture-api",
  limits: { contextWindowTokens: 8_000, maxOutputTokens: 512 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

const ECHO_TOOL = {
  name: "echo",
  description: "echo the supplied text",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    additionalProperties: false,
  },
} as const;

const TOOLS = [ECHO_TOOL];

const REPORT: ContextBuildReport = {
  estimatedInputTokens: 9,
  effectiveInputLimitTokens: 900,
  remainingTokens: 891,
  pressure: "NORMAL",
  compactionCount: 0,
  contributions: [
    { providerId: "turn", tokenEstimate: 9, itemCount: 1, droppedItems: 0, truncatedItems: 0 },
  ],
};

const POLICY: ToolObservationPolicySnapshot = {
  maxSingleObservationTokens: 80,
  maxObservationBatchTokens: 160,
};

/* ------------------------------------------------------------------ model */

/**
 * A scripted model stream: a Tool request turn, then a final-answer turn.
 *
 * The gateway is the real `AIGateway` port and the executor above it is the real frozen
 * `createModelTurnExecutor`, so the scripted part is only the provider's own output.
 */
function scriptedGateway(scripts: readonly (readonly AIStreamEvent[])[]): {
  readonly gateway: AIGateway;
  calls(): number;
} {
  let calls = 0;
  return {
    gateway: {
      stream(): Promise<AIStream> {
        const script = scripts[Math.min(calls, scripts.length - 1)]!;
        calls += 1;
        return Promise.resolve({
          callId: `llm_0195f3a0-0000-7000-8000-00000000000${calls}` as never,
          events: (async function* generate(): AsyncGenerator<AIStreamEvent> {
            for (const event of script) yield event;
          })(),
        });
      },
      complete(): Promise<AIModelTurnResult> {
        return Promise.reject(new Error("the standalone agent must stream, not complete"));
      },
    },
    calls: () => calls,
  };
}

function streamStart(callId: string): AIStreamEvent {
  return {
    type: "stream.start",
    payload: {
      callId: callId as never,
      providerId: "fixture",
      model: { provider: "fixture", model: "fixture-model" },
      resolution: {
        api: "fixture-api",
        reasoning: { mode: "NOT_REQUESTED", policy: "PREFER_BUDGET" },
        cache: { requested: "NONE", effective: "NONE", mode: "EXACT" },
      } as never,
    },
  };
}

const TOOL_TURN_SCRIPT: readonly AIStreamEvent[] = [
  streamStart("llm_0195f3a0-0000-7000-8000-000000000001"),
  { type: "text.delta", payload: { text: "let me look" } },
  {
    type: "tool_call.completed",
    payload: { id: "call_echo_1", name: "echo", input: { text: "alpha" } },
  },
  {
    type: "tool_call.completed",
    payload: { id: "call_echo_2", name: "echo", input: { text: "beta" } },
  },
  { type: "stream.finish", payload: { finishReason: "TOOL_CALLS" } },
];

const ANSWER_TURN_SCRIPT: readonly AIStreamEvent[] = [
  streamStart("llm_0195f3a0-0000-7000-8000-000000000002"),
  { type: "text.delta", payload: { text: "echo:alpha|echo:beta" } },
  { type: "stream.finish", payload: { finishReason: "STOP" } },
];

/* ------------------------------------------------------------- context port */

/**
 * A minimal Context Engine with no knowledge of anything but the turn it is asked about.
 *
 * It resolves no project, reads no file and consults no coding provider: it projects the turn's own
 * input onto the frozen message list. That is the whole point — an engine this small is enough, which
 * is what "the port is independent of Context V2" means.
 */
function echoContextEngine(): {
  readonly engine: ContextEnginePort;
  inputs(): readonly ContextPrepareInput[];
} {
  const inputs: ContextPrepareInput[] = [];
  return {
    engine: {
      prepare(input): Promise<PreparedModelContext> {
        inputs.push(input);
        const messages = [{ role: "user" as const, content: "fixture" }];
        return Promise.resolve({ messages, report: REPORT, observationPolicy: POLICY });
      },
    },
    inputs: () => inputs,
  };
}

/* ------------------------------------------------------- the echo Tool turn */

/**
 * A real frozen `ToolTurnCoordinator` over an echo function this file owns.
 *
 * It records the whole request so the test can assert *what the driver asked for* — the identity of
 * the batch, its order and its source Step — and it returns model-facing results only. It never
 * executes anything itself, and the kernel has no idea it exists.
 */
function echoToolTurn(): {
  readonly coordinator: ToolTurnCoordinator;
  calls(): readonly ToolTurnRequest[];
  results(): readonly { readonly externalCallId: string; readonly content: string }[];
} {
  const calls: ToolTurnRequest[] = [];
  const produced: { externalCallId: string; content: string }[] = [];
  return {
    coordinator: {
      execute(request: ToolTurnRequest) {
        calls.push(request);
        const results = request.pendingDecision.toolRequests.map((toolRequest) => {
          const args = toolRequest.args as { readonly text?: unknown };
          const content = `echo:${String(args.text)}`;
          produced.push({ externalCallId: toolRequest.externalCallId, content });
          return {
            externalCallId: toolRequest.externalCallId,
            toolName: toolRequest.toolName,
            content,
            isError: false,
          };
        });
        return Promise.resolve({ kind: "COMPLETED" as const, results });
      },
    },
    calls: () => calls,
    results: () => produced,
  };
}

/** The parenthesised context every effect is driven with. */
function effectContext(turn: { stepId: StepId; sequence: number }, signal: AbortSignal) {
  return {
    identity: IDENTITY,
    turn,
    conversation: CONVERSATION,
    model: MODEL,
    tools: TOOLS,
    signal,
  } satisfies RunExecutionEffectContext;
}

/* ------------------------------------------------------------------- tests */

describe("General Agent Run execution, standalone", () => {
  it("reasons, requests Tools, has them executed externally, and accepts the result", async () => {
    const gateway = scriptedGateway([TOOL_TURN_SCRIPT, ANSWER_TURN_SCRIPT]);
    const context = echoContextEngine();
    const modelTurnExecutor: ModelTurnExecutor = createModelTurnExecutor({
      gateway: gateway.gateway,
    });
    const loop = createAgentLoop({
      contextEngine: context.engine,
      modelTurnExecutor,
      decisionClassifier: createAgentDecisionClassifier(),
    });
    const toolTurns = echoToolTurn();
    const gate = createDirectAcceptCompletionGate();
    const driver = createRunExecutionDriver({
      agentLoop: loop,
      toolTurns: toolTurns.coordinator,
      completionGate: gate,
    });
    const signal = new AbortController().signal;

    /* 1. USER_INPUT → the Driver drives the real loop → a Tool request. */
    const firstStep: StepId = createStepId();
    const userInput = {
      kind: "USER_INPUT",
      userMessageId: USER_MESSAGE_ID,
    } satisfies AgentLoopAdvanceInput["input"];
    const first = await driver.execute(
      { kind: "ADVANCE_AGENT", mode: "EXECUTE", reason: "INITIAL", input: userInput },
      effectContext(createAgentTurnRef(firstStep, 1), signal),
    );

    expect(first.kind).toBe("AGENT");
    if (first.kind !== "AGENT") throw new Error("expected an Agent effect");
    expect(first.result.kind).toBe("TOOL_REQUESTS");
    if (first.result.kind !== "TOOL_REQUESTS") throw new Error("expected Tool requests");
    const requested = first.result.decision;
    expect(requested.type).toBe("TOOL_CALLS_REQUESTED");
    if (requested.type !== "TOOL_CALLS_REQUESTED") throw new Error("expected Tool requests");

    // The kernel reported exactly what the model asked for, in the model's own order, with the model's
    // own call ids — and nothing the kernel invented.
    expect(requested.toolRequests).toEqual([
      { externalCallId: "call_echo_1", toolName: "echo", args: { text: "alpha" } },
      { externalCallId: "call_echo_2", toolName: "echo", args: { text: "beta" } },
    ]);
    // The loop itself executed nothing: the echo adapter has not been called yet, and no Tool output
    // appears anywhere in the Reason's own result.
    expect(toolTurns.calls()).toHaveLength(0);
    expect(JSON.stringify(first.result)).not.toContain("echo:alpha");

    /* 2. The Driver executes the Tool batch through the external echo adapter. */
    const toolBatch = await driver.execute(
      {
        kind: "EXECUTE_TOOL_BATCH",
        mode: "EXECUTE",
        sourceStepId: firstStep,
        pendingDecision: requested,
        // The policy the requesting turn was prepared under is carried by the *directive*, which is the
        // durable record's own value: the driver must forward what the boundary holds rather than
        // re-derive it from the Context Engine it happens to share a process with.
        observationPolicy: POLICY,
      },
      effectContext(createAgentTurnRef(firstStep, 1), signal),
    );

    expect(toolBatch.kind).toBe("TOOLS");
    if (toolBatch.kind !== "TOOLS") throw new Error("expected a Tool effect");
    expect(toolBatch.result).toEqual({
      kind: "COMPLETED",
      results: [
        { externalCallId: "call_echo_1", toolName: "echo", content: "echo:alpha", isError: false },
        { externalCallId: "call_echo_2", toolName: "echo", content: "echo:beta", isError: false },
      ],
    });
    if (toolBatch.result.kind !== "COMPLETED") throw new Error("expected a complete batch");
    // The adapter received the driver's whole frozen request: the batch identity, the Step that
    // requested it, and the observation policy the turn was prepared under.
    expect(toolTurns.calls()).toHaveLength(1);
    expect(toolTurns.calls()[0]?.sourceStepId).toBe(firstStep);
    expect(toolTurns.calls()[0]?.observationPolicy).toEqual(POLICY);
    expect(toolTurns.calls()[0]?.mode).toBe("EXECUTE");
    // Results answer the requests one for one, in the requested order.
    expect(toolTurns.results().map((entry) => entry.externalCallId)).toEqual([
      "call_echo_1",
      "call_echo_2",
    ]);

    /* 3. TOOL_RESULTS → the Driver drives the loop again → a final candidate. */
    const secondStep: StepId = createStepId();
    const toolResults = toolBatch.result.results.map((result) => ({
      role: "tool" as const,
      toolCallId: result.externalCallId,
      toolName: result.toolName,
      content: result.content,
      isError: result.isError,
    }));
    const second = await driver.execute(
      {
        kind: "ADVANCE_AGENT",
        mode: "EXECUTE",
        reason: "TOOL_RESULTS",
        input: {
          kind: "TOOL_RESULTS",
          sourceStepId: firstStep,
          pendingDecision: requested,
          toolResultMessageIds: toolResults.map((result) =>
            agentMessageId(`result-${result.toolCallId}`),
          ),
        },
      },
      effectContext(createAgentTurnRef(secondStep, 2), signal),
    );

    expect(second.kind).toBe("AGENT");
    if (second.kind !== "AGENT") throw new Error("expected an Agent effect");
    expect(second.result.kind).toBe("FINAL_CANDIDATE");
    if (second.result.kind !== "FINAL_CANDIDATE") throw new Error("expected a candidate");
    expect(second.result.decision.candidateText).toBe("echo:alpha|echo:beta");
    // The candidate is reported as a candidate. Nothing about it is a completion.
    expect(JSON.stringify(second.result.decision)).not.toContain("COMPLETED");
    expect(second.result.decision.type).toBe("FINAL_CANDIDATE");
    // Each Reason appended its own messages exactly once: the opening user turn and the assistant
    // summary for the first, and the two Tool results plus the answer for the second. The original user
    // message is not appended again by the resumed Reason — the ledger is a ledger, not a transcript of
    // everything the provider was shown.
    expect(second.result.messagesToAppend.map((message) => message.role)).toEqual(["assistant"]);
    expect(first.result.messagesToAppend.map((message) => message.role)).toEqual(["assistant"]);

    /* 4. FINAL_CANDIDATE → the Driver evaluates it through the general CompletionGate → ACCEPT. */
    const completionStep: StepId = secondStep;
    const completion = await driver.execute(
      {
        kind: "EVALUATE_COMPLETION",
        mode: "EXECUTE",
        sourceStepId: completionStep,
        candidate: second.result.decision,
      },
      effectContext(createAgentTurnRef(completionStep, 2), signal),
    );

    expect(completion.kind).toBe("COMPLETION");
    if (completion.kind !== "COMPLETION") throw new Error("expected a completion effect");
    expect(completion.result).toEqual({
      kind: "ACCEPT",
      finalResult: { type: "TEXT", text: "echo:alpha|echo:beta" },
    });
    // The accepted result and the final candidate are different objects with different meanings: the
    // candidate is what the model said, the accepted result is what the Run is allowed to become.
    expect(
      completion.result.kind === "ACCEPT" && "candidateText" in completion.result.finalResult,
    ).toBe(false);

    /* The model was asked exactly twice, and the engine prepared exactly two turns. */
    expect(gateway.calls()).toBe(2);
    expect(context.inputs()).toHaveLength(2);
    expect(context.inputs()[1]?.input.kind).toBe("TOOL_RESULTS");
  });

  it("keeps the gate replaceable without touching the loop or the driver", async () => {
    const gateway = scriptedGateway([TOOL_TURN_SCRIPT, ANSWER_TURN_SCRIPT]);
    const context = echoContextEngine();
    const loop = createAgentLoop({
      contextEngine: context.engine,
      modelTurnExecutor: createModelTurnExecutor({ gateway: gateway.gateway }),
      decisionClassifier: createAgentDecisionClassifier(),
    });
    const toolTurns = echoToolTurn();

    // A second, entirely different policy: it refuses the candidate instead of accepting it. Swapping
    // it changes the completion outcome and nothing else — the same loop, the same driver, the same
    // Tool adapter, the same two model turns.
    const seen: CompletionGateInput[] = [];
    const refusingGate: CompletionGate = {
      id: "fixture-refusing-gate",
      evaluate: (input) => {
        seen.push(input);
        return Promise.resolve({
          kind: "REJECT",
          error: {
            code: "VERIFICATION_FAILED",
            message: "The candidate was refused.",
            retryable: false,
            phase: "VERIFICATION",
          },
        });
      },
    };

    const signal = new AbortController().signal;
    const step: StepId = createStepId();
    const first = await createRunExecutionDriver({
      agentLoop: loop,
      toolTurns: toolTurns.coordinator,
      completionGate: refusingGate,
    }).execute(
      {
        kind: "ADVANCE_AGENT",
        mode: "EXECUTE",
        reason: "INITIAL",
        input: { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID },
      },
      effectContext(createAgentTurnRef(step, 1), signal),
    );
    expect(first.kind).toBe("AGENT");

    const candidate = {
      type: "FINAL_CANDIDATE" as const,
      modelTurn: {
        callId: "llm_0150" as never,
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP" as const,
        assistantMessage: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "x" }],
        },
      },
      candidateText: "x",
    };

    // Same driver construction, different gate: the decision follows the gate, so the gate is the
    // policy and not a hard-wired part of the execution path.
    const refused = await createRunExecutionDriver({
      agentLoop: loop,
      toolTurns: toolTurns.coordinator,
      completionGate: refusingGate,
    }).execute(
      { kind: "EVALUATE_COMPLETION", mode: "EXECUTE", sourceStepId: step, candidate },
      effectContext(createAgentTurnRef(step, 1), signal),
    );
    expect(refused.kind === "COMPLETION" && refused.result.kind).toBe("REJECT");
    expect(seen).toHaveLength(1);
    // The gate was handed the identity, the source Step, the candidate, the mode and the signal — and
    // no host fact whatsoever.
    expect(seen[0]).toEqual({
      identity: IDENTITY,
      sourceStepId: step,
      candidate,
      mode: "EXECUTE",
      signal,
    });

    const accepted = await createRunExecutionDriver({
      agentLoop: loop,
      toolTurns: toolTurns.coordinator,
      completionGate: createDirectAcceptCompletionGate({ resultType: "ANSWER" }),
    }).execute(
      { kind: "EVALUATE_COMPLETION", mode: "RECOVER", sourceStepId: step, candidate },
      effectContext(createAgentTurnRef(step, 1), signal),
    );
    expect(accepted.kind === "COMPLETION" && accepted.result).toEqual({
      kind: "ACCEPT",
      finalResult: { type: "ANSWER", text: "x" },
    });
    expect(DIRECT_ACCEPT_COMPLETION_GATE_ID).toBe("caelush.accept-directly-completion-gate.v1");
  });

  it("suspends an aborted evaluation instead of accepting it", async () => {
    const gate = createDirectAcceptCompletionGate();
    const controller = new AbortController();
    controller.abort();
    const decision = await gate.evaluate({
      identity: IDENTITY,
      sourceStepId: createStepId(),
      candidate: {
        type: "FINAL_CANDIDATE",
        modelTurn: {
          callId: "llm_0151" as never,
          model: { provider: "fixture", model: "fixture-model" },
          finishReason: "STOP",
          assistantMessage: { role: "assistant", content: [{ type: "text", text: "x" }] },
        },
        candidateText: "x",
      },
      mode: "EXECUTE",
      signal: controller.signal,
    });

    // A cancelled evaluation is not an accepted one. `ERROR + retryable` leaves the decision to the
    // Run's termination authority, which is the only object allowed to settle a cancellation — the
    // gate itself has no `CANCELLED` arm to reach for.
    expect(decision.kind).toBe("ERROR");
    if (decision.kind !== "ERROR") throw new Error("expected a suspension");
    expect(decision.retryable).toBe(true);
    expect(decision.error.phase).toBe("VERIFICATION");
    expect(JSON.stringify(decision)).not.toContain("ACCEPT");
  });

  it("drives no further action once the signal is aborted", async () => {
    const gateway = scriptedGateway([TOOL_TURN_SCRIPT, ANSWER_TURN_SCRIPT]);
    const loop = createAgentLoop({
      contextEngine: echoContextEngine().engine,
      modelTurnExecutor: createModelTurnExecutor({ gateway: gateway.gateway }),
      decisionClassifier: createAgentDecisionClassifier(),
    });
    const toolTurns = echoToolTurn();
    const controller = new AbortController();
    controller.abort();

    const step: StepId = createStepId();
    const result = await createRunExecutionDriver({
      agentLoop: loop,
      toolTurns: toolTurns.coordinator,
      completionGate: createDirectAcceptCompletionGate(),
    }).execute(
      {
        kind: "ADVANCE_AGENT",
        mode: "EXECUTE",
        reason: "INITIAL",
        input: { kind: "USER_INPUT", userMessageId: USER_MESSAGE_ID },
      },
      effectContext(createAgentTurnRef(step, 1), controller.signal),
    );

    expect(result.kind === "AGENT" && result.result.kind).toBe("CANCELLED");
    // The signal reached the provider boundary before any turn was attempted, and no Tool ran.
    expect(gateway.calls()).toBe(0);
    expect(toolTurns.calls()).toHaveLength(0);
  });

  it("keeps two Runs' identities apart through the same driver composition", async () => {
    const gateway = scriptedGateway([ANSWER_TURN_SCRIPT]);
    const loop = createAgentLoop({
      contextEngine: echoContextEngine().engine,
      modelTurnExecutor: createModelTurnExecutor({ gateway: gateway.gateway }),
      decisionClassifier: createAgentDecisionClassifier(),
    });
    const other: AgentExecutionIdentity = { ...IDENTITY, runId: createRunId() };
    const seen: AgentExecutionIdentity[] = [];
    const recordingGate: CompletionGate = {
      id: "fixture-recording-gate",
      evaluate: (input) => {
        seen.push(input.identity);
        return Promise.resolve({
          kind: "ACCEPT",
          finalResult: { type: "TEXT", text: input.candidate.candidateText },
        });
      },
    };
    const driver = createRunExecutionDriver({
      agentLoop: loop,
      toolTurns: echoToolTurn().coordinator,
      completionGate: recordingGate,
    });
    const signal = new AbortController().signal;
    const candidate = {
      type: "FINAL_CANDIDATE" as const,
      modelTurn: {
        callId: "llm_0152" as never,
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "STOP" as const,
        assistantMessage: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "x" }],
        },
      },
      candidateText: "x",
    };
    const step: StepId = createStepId();

    for (const identity of [IDENTITY, other]) {
      await driver.execute(
        { kind: "EVALUATE_COMPLETION", mode: "EXECUTE", sourceStepId: step, candidate },
        { ...effectContext(createAgentTurnRef(step, 1), signal), identity },
      );
    }

    // A completion decision is about one Run: the identity the gate sees is the caller's own, never a
    // value carried over from the previous call.
    expect(seen).toEqual([IDENTITY, other]);
    expect(seen[0]?.runId).not.toBe(seen[1]?.runId);
  });

  it("reports a Tool effect result that never mentions a Run, a store or a Runtime", async () => {
    const toolTurns = echoToolTurn();
    const decision = {
      type: "TOOL_CALLS_REQUESTED" as const,
      modelTurn: {
        callId: "llm_0153" as never,
        model: { provider: "fixture", model: "fixture-model" },
        finishReason: "TOOL_CALLS" as const,
        assistantMessage: {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call_a",
              toolName: "echo",
              input: { text: "a" },
            },
          ],
        },
      },
      toolRequests: [{ externalCallId: "call_a", toolName: "echo", args: { text: "a" } }],
    };
    const effect: RunExecutionEffectResult = await createRunExecutionDriver({
      agentLoop: {
        advance: () => Promise.reject(new Error("an Agent turn must not run for a Tool directive")),
      },
      toolTurns: toolTurns.coordinator,
      completionGate: createDirectAcceptCompletionGate(),
    }).execute(
      {
        kind: "EXECUTE_TOOL_BATCH",
        mode: "EXECUTE",
        sourceStepId: createStepId(),
        pendingDecision: decision,
      },
      effectContext(createAgentTurnRef(createStepId(), 1), new AbortController().signal),
    );

    expect(effect.kind).toBe("TOOLS");
    // The model-facing Tool result vocabulary is four fields. No invocation id, no observation record,
    // no structured details, no Run identity and no host object crosses it.
    const serialized = JSON.stringify(effect);
    expect(serialized).not.toContain(IDENTITY.runId);
    expect(serialized).not.toContain("invocationId");
    expect(serialized).not.toContain("observation");
    expect(serialized).not.toContain("workspace");
  });
});
