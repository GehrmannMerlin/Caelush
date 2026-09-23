import type { JsonObject } from "@caelush/ai";
import {
  createEventId,
  createObservationId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  createDurableToolExecutionCoordinator,
  createModelToolFeedbackProjector,
  createToolAdmissionCoordinator,
  createToolBatchCoordinator,
  createToolCallPreparer,
  createToolFailureSettlement,
  createToolResultBatchNormalizer,
  createToolResultPipeline,
  DefaultAgentToolRegistryBuilder,
  DISCARDING_TOOL_EXECUTION_UPDATE_SINK,
  ToolExecutionConflictError,
  UNBOUNDED_TOOL_BUDGET_ADMISSION,
  type AgentTool,
  type ToolExecutionSnapshot,
  type ToolExecutionStorePort,
} from "@caelush/agent";

/**
 * The independent-use proof for the general Agent Tool framework.
 *
 * ```text
 * import only @caelush/agent's public API
 *   → register a pure in-memory echo AgentTool
 *   → build the registry
 *   → project modelSpecs()
 *   → prepare a call with ToolCallPreparer
 * ```
 *
 * No Coding Agent, no Runtime, no Storage implementation, no SQLite, no daemon and no provider.
 * What it proves is that registering and preparing Tools is a capability of the kernel by itself.
 *
 * What it does **not** prove, and must not be reported as proving: a durable Tool execution
 * pipeline. There is no Invocation, no admission, no approval, no executor and no settlement in this
 * round — those are Phases 4B to 4D, and the Tool System V2 pipeline is not complete without them.
 */

const echoTool: AgentTool = {
  name: "echo",
  description: "Echo the supplied text.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
    additionalProperties: false,
  },
  label: "Echo",
  resultDetailsSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  },
  executionMode: "SEQUENTIAL",
  execute: async ({ args }) => ({
    content: String(args.text),
    details: { echoed: String(args.text) },
    isError: false,
  }),
};

describe("independent use of the general Agent Tool framework", () => {
  it("registers, projects and prepares an in-memory Tool with @caelush/agent alone", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    const registry = builder.build();

    expect(registry.size).toBe(1);
    expect(registry.names()).toEqual(["echo"]);

    // The model-facing projection is exactly the AI tool spec.
    const specs = registry.modelSpecs();
    expect(specs).toEqual([
      {
        name: "echo",
        description: "Echo the supplied text.",
        inputSchema: echoTool.inputSchema,
      },
    ]);

    // And preparation resolves, bounds and validates against the same registry.
    const preparer = createToolCallPreparer(registry);
    const outcome = preparer.prepare({
      externalCallId: "call-1",
      toolName: "echo",
      args: { text: "hello" },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    expect(outcome.call.args).toEqual({ text: "hello" });
    expect(outcome.call.resolved.tool.label).toBe("Echo");
  });

  it("executes the in-memory Tool directly, with no pipeline around it", async () => {
    // `AgentTool.execute` is callable on its own: a host that has not yet composed the durable
    // pipeline can still run a Tool, which is what makes the contract independently usable.
    const result = await echoTool.execute({
      identity: {
        runId: "run-1" as never,
        sessionId: "session-1" as never,
        sourceStepId: "step-1" as never,
        invocationId: "invocation-1" as never,
        externalCallId: "call-1",
      },
      args: { text: "hello" },
      environment: {
        workspace: { id: "workspace-1" as never, path: "/workspace" },
        runtime: { id: "local", kind: "local" },
      },
      signal: new AbortController().signal,
      updates: { publish: () => undefined },
    });

    expect(result).toEqual({ content: "hello", details: { echoed: "hello" }, isError: false });
  });

  it("keeps a generic Tool free of every Coding field", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    const spec = builder.build().modelSpecs()[0]!;

    for (const codingField of [
      "riskLevel",
      "requiredCapabilities",
      "runtimeRequirements",
      "securityFactsProjector",
      "effectProjector",
      "presentation",
      "promptSnippet",
      "operations",
    ]) {
      expect(spec, `a generic AgentTool must not carry ${codingField}`).not.toHaveProperty(
        codingField,
      );
    }
    expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"]);
  });

  it("declares an execution mode without enabling concurrency", () => {
    // `PARALLEL_SAFE` is a declared future capability. Registering one changes nothing about how the
    // pipeline runs it, because this round has one execution order.
    const parallelSafe: AgentTool = {
      ...echoTool,
      name: "echo_parallel",
      executionMode: "PARALLEL_SAFE",
    };
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    builder.register(parallelSafe);
    const registry = builder.build();

    expect(registry.resolve("echo_parallel")?.tool.executionMode).toBe("PARALLEL_SAFE");
    expect(registry.names()).toEqual(["echo", "echo_parallel"]);
    // Nothing the registry exposes turns that declaration into a scheduler: there is no batch port,
    // no concurrency knob and no execution entry point on the canonical registry.
    for (const schedulerish of ["execute", "dispatch", "batch", "concurrency", "parallel"]) {
      expect(registry).not.toHaveProperty(schedulerish);
    }
  });

  it("rejects an argument payload that does not match the registered schema", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    const preparer = createToolCallPreparer(builder.build());

    const outcome = preparer.prepare({
      externalCallId: "call-1",
      toolName: "echo",
      args: {} as JsonObject,
    });

    expect(outcome.kind).toBe("REJECTED");
    if (outcome.kind !== "REJECTED") throw new Error("expected REJECTED");
    expect(outcome.feedback.disposition).toBe("SAFE_FAILURE");
    expect(outcome.feedback.code).toBe("TOOL_ARGUMENT_ERROR");
  });

  /**
   * The independent-use proof for the canonical Tool batch.
   *
   * ```text
   * @caelush/agent + @caelush/ai + @caelush/protocol, and nothing else
   *   → register an in-memory echo Tool
   *   → prepare a call
   *   → run the canonical ToolBatchCoordinator over narrow in-memory durable ports
   *   → produce a durable ToolObservation
   *   → project an AIToolResultMessage
   * ```
   *
   * No `@caelush/coding-agent`, no Runtime, no Storage implementation, no Security package and no
   * `@caelush/tools`. What it proves is that scheduling a Tool batch, settling it durably and projecting
   * the model's view are capabilities of the kernel by itself — the host supplies only the narrow ports
   * the frozen contracts name.
   */
  it("runs a canonical batch end to end with @caelush/agent alone", async () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    builder.register(echoTool);
    const registry = builder.build();

    // The in-memory durable store the coordinator commits through. It is a test double for the *store
    // port*, not for the coordinator: the lifecycle under test is the real one.
    const snapshots = new Map<string, ToolExecutionSnapshot>();
    const store: ToolExecutionStorePort = {
      async load(invocationId) {
        return snapshots.get(invocationId) ?? null;
      },
      async findByExternalCall(runId, stepId, externalCallId) {
        return (
          [...snapshots.values()].find(
            ({ invocation }) =>
              invocation.runId === runId &&
              invocation.stepId === stepId &&
              invocation.externalCallId === externalCallId,
          ) ?? null
        );
      },
      async commit(command) {
        const current = snapshots.get(command.invocation.id);
        if ((current?.revision ?? null) !== command.expectedRevision) {
          throw new ToolExecutionConflictError("revision conflict");
        }
        const snapshot: ToolExecutionSnapshot = {
          sessionId: command.sessionId,
          invocation: command.invocation,
          revision: (current?.revision ?? 0) + 1,
          ...(command.observation === undefined ? {} : { observation: command.observation }),
          ...(command.approval === undefined ? {} : { approval: command.approval }),
        };
        snapshots.set(command.invocation.id, snapshot);
        return { snapshot, events: [] };
      },
    };

    let now = 100;
    const clock = { now: () => createTimestampMs(++now) };
    const durable = createDurableToolExecutionCoordinator({
      store,
      admission: createToolAdmissionCoordinator({
        // Policy, approval and budget all default to "this host admits every call": a general Agent
        // host with no security subsystem supplies exactly this.
        policy: {
          async evaluate() {
            return { kind: "ALLOW" as const };
          },
        },
        budget: UNBOUNDED_TOOL_BUDGET_ADMISSION,
        clock,
        eventIdFactory: { create: createEventId },
      }),
      metadata: { get: () => ({ riskLevel: "LOW" as const }) },
      approvalRequests: () => null,
      invocationIdFactory: { create: createToolInvocationId },
      observationIdFactory: { create: createObservationId },
      eventIdFactory: { create: createEventId },
      clock,
      invocationExecutorFactory: () => ({
        async execute({ call, identity, environment }) {
          // The real §4B executor shape: it calls the registered `AgentTool.execute` with the frozen
          // identity and input, and nothing else.
          return await call.resolved.tool.execute({
            identity,
            args: call.args,
            environment,
            signal: new AbortController().signal,
            updates: DISCARDING_TOOL_EXECUTION_UPDATE_SINK,
          });
        },
      }),
      updateSanitizer: { sanitize: () => null },
      // The real §4B result pipeline over its own defaults: full contract validation, the identity
      // sanitizer and the durable bound. It needs no host configuration at all.
      resultPipelineFactory: () => createToolResultPipeline(),
      preparedCallFactory: ({ invocation, externalCallId }) => ({
        request: { externalCallId, toolName: invocation.toolName, args: invocation.args },
        resolved: registry.resolve(invocation.toolName) as never,
        args: invocation.args,
      }),
      failureSettlement: createToolFailureSettlement({
        store,
        clock,
        observationIdFactory: { create: createObservationId },
        eventIdFactory: { create: createEventId },
        boundContent: (content) => content,
      }),
    });

    const batch = createToolBatchCoordinator({
      preparer: createToolCallPreparer(registry),
      budget: UNBOUNDED_TOOL_BUDGET_ADMISSION,
      durable,
      registry,
    });

    const outcome = await batch.execute({
      runId: createRunId(),
      sessionId: createSessionId(),
      sourceStepId: createStepId(),
      calls: [
        { externalCallId: "call_echo", toolName: "echo", args: { text: "hello" } },
        { externalCallId: "call_missing", toolName: "not_registered", args: {} },
      ],
      environment: {
        workspace: { id: createWorkspaceId(), path: "/workspace" },
        runtime: { id: "local", kind: "local" },
      },
      securityContext: { permissionProfile: "FULL_ACCESS", approvalPolicy: "NEVER_ASK" },
      signal: new AbortController().signal,
    });

    if (outcome.kind !== "COMPLETED") throw new Error("expected COMPLETED");
    expect(outcome.items.map((item) => item.kind)).toEqual(["OBSERVATION", "REJECTED"]);

    const observation = outcome.items[0];
    if (observation?.kind !== "OBSERVATION") throw new Error("expected an observation");
    expect(observation.observation.content).toBe("hello");
    expect(observation.observation.isError).toBe(false);

    // The rejection created no durable row: exactly one invocation exists, for the executed call.
    expect(snapshots.size).toBe(1);

    // And the canonical projector turns the batch into the model's view, one message per call.
    const projector = createModelToolFeedbackProjector();
    const messages = projector.project({
      calls: [
        { externalCallId: "call_echo", toolName: "echo", args: { text: "hello" } },
        { externalCallId: "call_missing", toolName: "not_registered", args: {} },
      ],
      items: outcome.items,
      policy: { maxSingleObservationTokens: 1_000, maxObservationBatchTokens: 4_000 },
    });

    expect(messages.map((projected) => projected.message)).toEqual([
      {
        role: "tool",
        toolCallId: "call_echo",
        toolName: "echo",
        content: "hello",
        isError: false,
      },
      {
        role: "tool",
        toolCallId: "call_missing",
        toolName: "not_registered",
        content: expect.stringContaining("not_registered"),
        isError: true,
      },
    ]);
    // The normalizer accepts it, so the whole exit is composable without an adapter.
    expect(
      createToolResultBatchNormalizer().normalize({
        requests: [
          { externalCallId: "call_echo", toolName: "echo", args: { text: "hello" } },
          { externalCallId: "call_missing", toolName: "not_registered", args: {} },
        ],
        results: messages.map((projected) => projected.message),
      }),
    ).toHaveLength(2);
  });
});
