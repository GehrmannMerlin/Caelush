import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";
import { createLegacyNumericArgumentNormalization } from "@caelush/coding-agent";
import {
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
 * Production Tool composition delegation.
 *
 * ```text
 * createDefaultBuiltinToolRegistrations  →  ToolRegistryBuilder  (delegates to @caelush/agent)
 *                                       →  filterToolRegistryForEnvironment
 *                                       →  createV1SecureToolDispatcher
 * ```
 *
 * This is the same chain `apps/daemon/src/daemon-composition.ts` composes. What it proves is that the
 * production composition reaches the **canonical** registry and Preparer rather than a private
 * legacy copy: the canonical registry is the one the facade carries, its model specs are the ones
 * the legacy DTOs project, and `prepareToolCall` — the canonical preparation boundary the dispatcher
 * exposes — resolves, normalizes, bounds and validates the nine default Tools.
 *
 * It does not prove durable Tool execution: the dispatcher's pipeline stages are Phase 4B to 4D, and
 * nothing here dispatches a call.
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
    // The registration-level argument compatibility normalization, supplied by the composition root
    // exactly as `apps/daemon/src/daemon-composition.ts` supplies it.
    normalization: createLegacyNumericArgumentNormalization(),
  } satisfies V1SecureToolDispatcherOptions;
  return { registry, options };
}

describe("production secure Tool dispatcher composition", () => {
  it("composes the nine defaults through the canonical registry", () => {
    const { registry, options } = dispatcherOptions();
    const dispatcher = createV1SecureToolDispatcher(options);

    expect(registry.names()).toEqual([
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
    expect(dispatcher.modelDefinitions().map((definition) => definition.name)).toEqual(
      registry.names(),
    );
    expect(
      registry
        .agentRegistry()
        .modelSpecs()
        .map((spec) => spec.name),
    ).toEqual(registry.names());
  });

  it("prepares a production Tool call through the canonical Preparer", () => {
    const { registry, options } = dispatcherOptions();
    const dispatcher = createV1SecureToolDispatcher(options);

    const outcome = dispatcher.prepareToolCall({
      externalCallId: "call-1",
      toolName: "read_file",
      args: { path: "src/index.ts" },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    // The resolved value is the canonical entry, taken from the registry this composition built.
    expect(outcome.call.resolved).toBe(registry.agentRegistry().resolve("read_file"));
    expect(outcome.call.args).toEqual({ path: "src/index.ts" });
  });

  it("keeps the numeric-string compatibility normalization on the production path", () => {
    const { options } = dispatcherOptions();
    const dispatcher = createV1SecureToolDispatcher(options);

    const outcome = dispatcher.prepareToolCall({
      externalCallId: "call-1",
      toolName: "exec_command",
      args: { cmd: "pnpm test", yield_time_ms: "3000" },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    // `coerceTypes` stays false in the schema runtime; the conversion happened because the legacy
    // registration carries the declared compatibility normalization, and it happened once.
    expect(outcome.call.args).toEqual({ cmd: "pnpm test", yield_time_ms: 3000 });
  });

  it("rejects an unavailable Tool and an invalid payload as safe feedback", () => {
    const { options } = dispatcherOptions();
    const dispatcher = createV1SecureToolDispatcher(options);

    const unknown = dispatcher.prepareToolCall({
      externalCallId: "call-1",
      toolName: "missing_tool",
      args: {},
    });
    expect(unknown.kind).toBe("REJECTED");
    if (unknown.kind === "REJECTED") {
      expect(unknown.feedback.code).toBe("TOOL_UNAVAILABLE");
      expect(unknown.feedback.disposition).toBe("SAFE_FAILURE");
    }

    const invalid = dispatcher.prepareToolCall({
      externalCallId: "call-2",
      toolName: "read_file",
      args: { path: "src/index.ts", unexpected: true },
    });
    expect(invalid.kind).toBe("REJECTED");
    if (invalid.kind === "REJECTED") expect(invalid.feedback.code).toBe("TOOL_ARGUMENT_ERROR");
  });

  it("creates no Invocation while preparing", () => {
    const { options } = dispatcherOptions();
    const dispatcher = createV1SecureToolDispatcher(options);

    const outcome = dispatcher.prepareToolCall({
      externalCallId: "call-1",
      toolName: "read_file",
      args: { path: "src/index.ts" },
    });

    // The canonical outcome carries no durable identity, and the store was never asked for one.
    expect(outcome).not.toHaveProperty("invocation");
    if (outcome.kind === "READY") {
      expect(outcome.call).not.toHaveProperty("invocationId");
      expect(Object.keys(outcome.call).sort()).toEqual(["args", "request", "resolved"]);
    }
  });

  it("composes no Coding catalog entry without a registered Tool", () => {
    const { registry } = dispatcherOptions();

    // The environment filter rebuilt both halves from one resolved entry, so every overlay name
    // resolves and every resolved Tool has its overlay. A mismatch here would mean the filter
    // recreated an authority of its own.
    for (const name of registry.names()) {
      const resolved = registry.resolve(name)!;
      expect(resolved.coding).toBeDefined();
      expect(resolved.agentTool).toBeDefined();
    }
  });
});
