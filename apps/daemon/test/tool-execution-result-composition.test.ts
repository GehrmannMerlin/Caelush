import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import {
  CaelushToolExecutionUpdateSanitizer,
  createV1SecureToolDispatcher,
  type V1SecureToolDispatcherOptions,
} from "@caelush/security";
import {
  createDefaultBuiltinToolRegistrations,
  filterToolRegistryForEnvironment,
  ToolRegistryBuilder,
} from "@caelush/tools";
import {
  createApprovalRequestId,
  createEventId,
  createObservationId,
  createTimestampMs,
  createToolInvocationId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

/**
 * Production result composition delegation.
 *
 * ```text
 * createV1SecureToolDispatcher
 *   ├─ CaelushToolResultSanitizer   → behind the Agent layer's ToolResultSanitizerPort
 *   ├─ CaelushToolExecutionUpdateSanitizer → the transient update sanitizer
 *   └─ execution: { executor factory, update sanitizer, result pipeline factory }
 * ```
 *
 * This is the chain `apps/daemon/src/daemon-composition.ts` composes. What it proves is that the
 * production composition reaches the canonical execution pair and that the real Security
 * implementations sit behind the Agent ports — not a legacy copy of either.
 */

function defaultRegistry() {
  const builder = new ToolRegistryBuilder();
  for (const registration of createDefaultBuiltinToolRegistrations(
    createLocalRuntimeResolver(new LocalRuntime()),
  )) {
    builder.register(registration);
  }
  return filterToolRegistryForEnvironment(builder.build(), { git: "AVAILABLE" });
}

function dispatcherOptions() {
  const registry = defaultRegistry();
  const store = {
    findByExternalCall: async () => null,
    load: async () => null,
    commit: async () => {
      throw new Error("this test never dispatches a Tool call");
    },
  };
  const options = {
    registry,
    store: store as never,
    notifier: { notifyCommitted() {} },
    clock: { now: () => createTimestampMs(1) },
    invocationIdFactory: { create: createToolInvocationId },
    observationIdFactory: { create: createObservationId },
    eventIdFactory: { create: createEventId },
    approvalStore: {
      getByInvocation: async () => null,
      findApplicableRunGrant: async () => null,
    },
    approvalIdFactory: { create: createApprovalRequestId },
    terminalOutputSanitizer: (value: string) => value,
    securityToolNames: registry.names(),
    updateSanitizer: new CaelushToolExecutionUpdateSanitizer(),
  } satisfies V1SecureToolDispatcherOptions;
  return { registry, options };
}

describe("production secure Tool dispatcher execution composition", () => {
  it("binds the canonical execution pair and the real result sanitizer", () => {
    const { options } = dispatcherOptions();
    const dispatcher = createV1SecureToolDispatcher(options);
    const execution = (
      dispatcher as unknown as {
        options: {
          execution: {
            invocationExecutorFactory: unknown;
            updateSanitizer: unknown;
            resultPipelineFactory: unknown;
            outputPolicy: unknown;
          };
        };
      }
    ).options.execution;

    expect(execution.invocationExecutorFactory).toBeTypeOf("function");
    expect(execution.resultPipelineFactory).toBeTypeOf("function");
    expect(execution.updateSanitizer).toBeInstanceOf(CaelushToolExecutionUpdateSanitizer);
    // The legacy `resultSanitizer` option is gone from the dispatcher: the sanitizer reaches the
    // pipeline through the execution group only.
    expect(
      (dispatcher as unknown as { options: Record<string, unknown> }).options,
    ).not.toHaveProperty("resultSanitizer");
  });

  it("builds a result pipeline per invocation that sanitizes with the Security implementation", () => {
    const { registry, options } = dispatcherOptions();
    const dispatcher = createV1SecureToolDispatcher(options);
    const execution = (
      dispatcher as unknown as {
        options: {
          execution: {
            resultPipelineFactory: (input: { invocation: unknown; environment: unknown }) => {
              process: (input: unknown) => unknown;
            };
          };
        };
      }
    ).options.execution;

    const pipeline = execution.resultPipelineFactory({
      invocation: {
        id: createToolInvocationId(),
        runId: "run-1",
        stepId: "step-1",
        toolName: "read_file",
        externalCallId: "call-1",
        args: { path: "src/index.ts" },
        riskLevel: "LOW",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
      environment: {
        workspace: { id: "workspace-1", path: "C:\\workspace" },
        runtime: { id: "local", kind: "local" },
      },
    });

    // The pipeline sanitizes with the real Security primitive: an obvious credential is redacted.
    const settlement = pipeline.process({
      call: {
        request: {
          externalCallId: "call-1",
          toolName: "read_file",
          args: { path: "src/index.ts" },
        },
        resolved: registry.agentRegistry().resolve("read_file"),
        args: { path: "src/index.ts" },
      },
      invocation: {
        id: createToolInvocationId(),
        runId: "run-1",
        stepId: "step-1",
        toolName: "read_file",
        externalCallId: "call-1",
        args: { path: "src/index.ts" },
        riskLevel: "LOW",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
      rawResult: {
        content: "API_KEY=supersecretvalue",
        details: { ok: true },
        isError: false,
      },
      now: createTimestampMs(2),
    }) as { result: { content: string } };

    expect(settlement.result.content).not.toContain("supersecretvalue");
    expect(settlement.result.content).toContain("[REDACTED]");
  });

  it("sends an obvious credential in a transient update through the update sanitizer", () => {
    const sanitizer = new CaelushToolExecutionUpdateSanitizer();
    const updateSanitizer = sanitizer.sanitize({
      toolName: "exec_command",
      invocation: {
        id: createToolInvocationId(),
        runId: "run-1",
        stepId: "step-1",
        toolName: "exec_command",
        externalCallId: "call-1",
        args: { cmd: "env" },
        riskLevel: "MEDIUM",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
      update: { kind: "OUTPUT", stream: "stdout", chunk: "Authorization: Bearer abcdef123456" },
    });

    expect(updateSanitizer).not.toBeNull();
    expect(JSON.stringify(updateSanitizer)).not.toContain("abcdef123456");
    expect(JSON.stringify(updateSanitizer)).toContain("[REDACTED]");
  });

  it("refuses a transient update that would expose a host path", () => {
    const sanitizer = new CaelushToolExecutionUpdateSanitizer();
    const dropped = sanitizer.sanitize({
      toolName: "exec_command",
      invocation: {
        id: createToolInvocationId(),
        runId: "run-1",
        stepId: "step-1",
        toolName: "exec_command",
        externalCallId: "call-1",
        args: { cmd: "ls" },
        riskLevel: "MEDIUM",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
      update: { kind: "OUTPUT", stream: "stdout", chunk: "C:\\Users\\someone\\.ssh\\id_rsa" },
    });

    expect(dropped).toBeNull();
  });

  it("keeps the update sanitizer out of the durable path", () => {
    const sanitizer = new CaelushToolExecutionUpdateSanitizer();
    const sanitized = sanitizer.sanitize({
      toolName: "exec_command",
      invocation: {
        id: createToolInvocationId(),
        runId: "run-1",
        stepId: "step-1",
        toolName: "exec_command",
        externalCallId: "call-1",
        args: { cmd: "ls" },
        riskLevel: "MEDIUM",
        status: "RUNNING",
        createdAt: createTimestampMs(1),
      },
      update: { kind: "PROGRESS", message: "halfway", completed: 1, total: 2 },
    });

    expect(sanitized).toEqual({ kind: "PROGRESS", message: "halfway", completed: 1, total: 2 });
  });

  it("composes the nine defaults through the canonical registry unchanged", () => {
    const { registry, options } = dispatcherOptions();
    const dispatcher = createV1SecureToolDispatcher(options);

    expect(dispatcher.modelDefinitions().map((definition) => definition.name)).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "exec_command",
      "write_stdin",
      "git_status",
      "git_diff",
    ]);
    expect(
      registry
        .agentRegistry()
        .modelSpecs()
        .map((spec) => spec.name),
    ).toEqual(registry.names());
    // Names, order and schemas are untouched by this round.
    for (const name of registry.names()) {
      const spec = registry
        .agentRegistry()
        .modelSpecs()
        .find((entry) => entry.name === name)!;
      expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"]);
      expect(spec.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("constructs its own result sanitizer rather than accepting one from a caller", () => {
    const { options } = dispatcherOptions();
    // The legacy `resultSanitizer` option is not part of the composition surface any more, so a
    // caller cannot substitute a weaker sanitizer for the one the production pipeline uses.
    const patched = {
      ...options,
      resultSanitizer: { sanitize: ({ result }: { result: unknown }) => result },
    } as unknown as V1SecureToolDispatcherOptions;
    const dispatcher = createV1SecureToolDispatcher(patched);
    const execution = (dispatcher as unknown as { options: { execution: Record<string, unknown> } })
      .options.execution;

    expect(Object.keys(execution).sort()).toEqual([
      "invocationExecutorFactory",
      "outputPolicy",
      "resultPipelineFactory",
      "updateSanitizer",
    ]);
    expect(execution.updateSanitizer).toBeInstanceOf(CaelushToolExecutionUpdateSanitizer);
  });
});
