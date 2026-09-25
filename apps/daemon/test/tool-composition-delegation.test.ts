import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { sanitizeTerminalOutput } from "@caelush/runtime";
import {
  assertDefaultBuiltinSecurityCoverage,
  CaelushToolExecutionGate,
  CaelushToolResultSanitizer,
  CaelushToolExecutionUpdateSanitizer,
  createDefaultV1ToolExecutionSecurity,
  DISCARDING_TOOL_UPDATE_CONSUMER,
} from "@caelush/security";
import {
  CODING_TOOL_EFFECTS_PAYLOAD_KIND,
  createCodingToolSettlementExtensionProjector,
  createLegacyNumericArgumentNormalization,
  DEFAULT_CODING_TOOL_ORDER,
} from "@caelush/coding-agent";
import {
  createToolCallPreparer,
  createToolInvocationExecutor,
  createToolResultPipeline,
  type DurableInvocationExecutorFactory,
  type DurableResultPipelineFactory,
  type ToolExecutionEnvironment,
  type ToolInvocationExecutor,
  type ToolResultPipeline,
} from "@caelush/agent";
import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ToolInvocation,
} from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createCodingToolComposition } from "./support/coding-tool-composition.js";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";

/**
 * Production Tool composition delegation.
 *
 * ```text
 * Runtime Operations adapters            @caelush/coding-agent
 *   → createDefaultCodingTools(...)      the nine Coding Tool definitions
 *   → DefaultAgentToolRegistryBuilder    the canonical AgentToolRegistry
 *   → CodingToolCatalogBuilder           the Coding overlay, aligned to that registry
 *        ↓
 * ToolInvocationExecutor                 @caelush/agent, executing the resolved AgentTool
 * ToolResultPipeline                     @caelush/agent, over the real Security result sanitizer
 * CaelushToolExecutionGate               @caelush/security, the real policy evaluator
 * ```
 *
 * This is the chain `apps/daemon/src/daemon-composition.ts` composes. What it proves is that the
 * assembly reaches the **canonical** objects rather than a private copy: the executor executes the
 * Coding Tool the registry resolved, the pipeline sanitizes with the real Security implementation and
 * settles the Coding effect vocabulary the catalog owns, and the gate answers with the real policy.
 *
 * Phase 4F deleted the legacy `createV1SecureToolDispatcher` this file used to inspect, so the
 * assertions that read its private options are gone. The composition root's own helpers are private
 * too, which is why the wiring below is mirrored from it with real objects rather than reached through
 * a back door; the first case pins the same alignment on the real production root.
 */

/** The frozen default Coding Tool order, restated here as an independent oracle. */
const EXPECTED_DEFAULT_TOOL_ORDER = [
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "git_status",
  "git_diff",
];

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let daemon: DaemonComposition | undefined;

afterEach(async () => {
  await daemon?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  daemon = undefined;
});

function toolSecurity() {
  return createDefaultV1ToolExecutionSecurity({
    terminalOutputSanitizer: sanitizeTerminalOutput,
  });
}

function environmentFor(path: string): ToolExecutionEnvironment {
  return { workspace: { id: createWorkspaceId(), path }, runtime: { id: "local", kind: "local" } };
}

function runningInvocation(input: {
  readonly toolName: ToolInvocation["toolName"];
  readonly args: ToolInvocation["args"];
  readonly runId: ToolInvocation["runId"];
  readonly stepId: ToolInvocation["stepId"];
  readonly riskLevel?: ToolInvocation["riskLevel"];
}): ToolInvocation {
  return {
    id: createToolInvocationId(),
    runId: input.runId,
    stepId: input.stepId,
    toolName: input.toolName,
    externalCallId: "call-1",
    args: input.args,
    riskLevel: input.riskLevel ?? "LOW",
    status: "RUNNING",
    createdAt: createTimestampMs(1),
  };
}

describe("production Tool composition delegation", () => {
  it("composes the nine defaults through the production root unchanged", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-tool-delegation-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    daemon = await composeDaemon({ storage });

    // The production root's registry is the canonical one, in the frozen Coding order.
    expect(daemon.toolRegistry.names()).toEqual(EXPECTED_DEFAULT_TOOL_ORDER);
    expect(daemon.toolRegistry.names()).toEqual([...DEFAULT_CODING_TOOL_ORDER]);
    expect(daemon.toolRegistry.size).toBe(9);

    // One registry, never two: the Run Layer's model catalog is that registry's own model specs.
    expect(daemon.toolTurn.modelSpecs()).toBe(daemon.toolRegistry.modelSpecs());
    for (const spec of daemon.toolRegistry.modelSpecs()) {
      // Exactly the three model-facing fields. Risk, capabilities, runtime requirements and the
      // result details schema stay in the Coding overlay and never reach a provider request.
      expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"]);
    }
  });

  it("aligns the canonical registry with the Coding catalog it was built from", () => {
    const { registry, catalog, definitions } = createCodingToolComposition();

    expect(catalog.names()).toEqual(registry.names());
    expect(definitions.map((definition) => definition.tool.name)).toEqual(registry.names());
    for (const name of registry.names()) {
      // Both halves resolve: the executable Tool and the overlay that describes it.
      expect(registry.resolve(name), name).toBeDefined();
      expect(catalog.get(name), name).toBeDefined();
    }

    // The Security coverage self-check the production root runs at startup. It is not vacuous: an
    // expected Tool the registry cannot execute is refused.
    expect(() =>
      assertDefaultBuiltinSecurityCoverage(registry, catalog, registry.names()),
    ).not.toThrow();
    expect(() =>
      assertDefaultBuiltinSecurityCoverage(registry, catalog, [
        ...registry.names(),
        "missing_tool",
      ]),
    ).toThrow();
  });

  it("prepares a production Tool call through the canonical Preparer", () => {
    const { registry } = createCodingToolComposition();
    const preparer = createToolCallPreparer(registry, {
      normalization: createLegacyNumericArgumentNormalization(),
    });

    const outcome = preparer.prepare({
      externalCallId: "call-1",
      toolName: "read_file",
      args: { path: "src/index.ts" },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    // The resolved value is the canonical entry, taken from the registry this composition built.
    expect(outcome.call.resolved).toBe(registry.resolve("read_file"));
    expect(outcome.call.args).toEqual({ path: "src/index.ts" });
    // The canonical prepared call carries no durable identity at all.
    expect(outcome.call).not.toHaveProperty("invocationId");
    expect(Object.keys(outcome.call).sort()).toEqual(["args", "request", "resolved"]);
  });

  it("keeps the numeric-string compatibility normalization on the production path", () => {
    const { registry } = createCodingToolComposition();
    const preparer = createToolCallPreparer(registry, {
      normalization: createLegacyNumericArgumentNormalization(),
    });

    const outcome = preparer.prepare({
      externalCallId: "call-1",
      toolName: "exec_command",
      args: { cmd: "pnpm test", yield_time_ms: "3000" },
    });

    expect(outcome.kind).toBe("READY");
    if (outcome.kind !== "READY") throw new Error("expected READY");
    // The schema runtime still does not coerce; the conversion happened because the production
    // composition supplies the declared compatibility normalization, and it happened once.
    expect(outcome.call.args).toEqual({ cmd: "pnpm test", yield_time_ms: 3000 });
  });

  it("rejects an unavailable Tool and an invalid payload as safe feedback", () => {
    const { registry } = createCodingToolComposition();
    const preparer = createToolCallPreparer(registry);

    const unknown = preparer.prepare({
      externalCallId: "call-1",
      toolName: "missing_tool",
      args: {},
    });
    expect(unknown.kind).toBe("REJECTED");
    if (unknown.kind === "REJECTED") {
      expect(unknown.feedback.code).toBe("TOOL_UNAVAILABLE");
      expect(unknown.feedback.disposition).toBe("SAFE_FAILURE");
    }

    const invalid = preparer.prepare({
      externalCallId: "call-2",
      toolName: "read_file",
      args: { path: "src/index.ts", unexpected: true },
    });
    expect(invalid.kind).toBe("REJECTED");
    if (invalid.kind === "REJECTED") expect(invalid.feedback.code).toBe("TOOL_ARGUMENT_ERROR");
  });

  it("builds the invocation executor from the canonical factory and runs the resolved Coding Tool", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-tool-delegation-"));
    await writeFile(join(directory, "listed-by-the-tool.txt"), "caelush\n", "utf8");
    const { registry } = createCodingToolComposition();
    const resolved = registry.resolve("list_directory");
    if (resolved === undefined) throw new Error("list_directory must be registered");

    // The production invocation-executor factory, mirrored from `daemon-composition.ts`.
    const invocationExecutorFactory: DurableInvocationExecutorFactory = ({
      invocation,
      updateSanitizer,
    }) =>
      createToolInvocationExecutor({
        invocation,
        updateSanitizer,
        transientUpdates: DISCARDING_TOOL_UPDATE_CONSUMER,
      });

    const runId = createRunId();
    const stepId = createStepId();
    const invocation = runningInvocation({
      toolName: "list_directory",
      args: { path: "." },
      runId,
      stepId,
    });
    const executor: ToolInvocationExecutor = invocationExecutorFactory({
      invocation,
      updateSanitizer: new CaelushToolExecutionUpdateSanitizer(),
    });

    const result = await executor.execute({
      call: {
        request: { externalCallId: "call-1", toolName: "list_directory", args: { path: "." } },
        resolved,
        args: { path: "." },
      },
      identity: {
        runId,
        sessionId: createSessionId(),
        sourceStepId: stepId,
        invocationId: invocation.id,
        externalCallId: "call-1",
      },
      environment: environmentFor(directory),
      signal: new AbortController().signal,
    });

    // The canonical executor reached the Coding Tool the canonical registry resolved.
    expect(result.isError).toBe(false);
    expect(result.content).toContain("listed-by-the-tool.txt");
  });

  it("puts the real Security result sanitizer behind the canonical result pipeline", () => {
    const { registry, catalog } = createCodingToolComposition();
    const security = toolSecurity();
    const resolved = registry.resolve("read_file");
    if (resolved === undefined) throw new Error("read_file must be registered");
    expect(security.resultSanitizer).toBeInstanceOf(CaelushToolResultSanitizer);

    const runId = createRunId();
    const stepId = createStepId();
    const environment = environmentFor(process.cwd());
    const invocation = runningInvocation({
      toolName: "read_file",
      args: { path: "src/index.ts" },
      runId,
      stepId,
    });

    // The production result-pipeline factory, mirrored from `daemon-composition.ts`: the real
    // Security sanitizer plus the Coding settlement extension the catalog owns.
    const resultPipelineFactory: DurableResultPipelineFactory = ({
      invocation: durableInvocation,
      environment: durableEnvironment,
      sessionId,
    }) =>
      createToolResultPipeline({
        sanitizer: security.resultSanitizer,
        settlementExtension: createCodingToolSettlementExtensionProjector({
          catalog,
          invocation: {
            invocation: durableInvocation,
            ...(sessionId === undefined ? {} : { sessionId }),
            environment: durableEnvironment,
            nextEventId: () => createEventId(),
            presentation: security.presentation,
          },
        }),
      });

    const pipeline: ToolResultPipeline = resultPipelineFactory({
      invocation,
      environment,
      sessionId: createSessionId(),
    });

    const settlement = pipeline.process({
      call: {
        request: {
          externalCallId: "call-1",
          toolName: "read_file",
          args: { path: "src/index.ts" },
        },
        resolved,
        args: { path: "src/index.ts" },
      },
      invocation,
      rawResult: {
        content: "API_KEY=supersecretvalue",
        details: { ok: true, path: "src/index.ts" },
        isError: false,
      },
      now: createTimestampMs(2),
    });

    // The real Security sanitizer, not an identity pass-through.
    expect(settlement.result.content).not.toContain("supersecretvalue");
    expect(settlement.result.content).toContain("[REDACTED]");
    // And the Coding settlement extension travels beside the result, opaquely, from the catalog.
    expect(settlement.effects?.kind).toBe(CODING_TOOL_EFFECTS_PAYLOAD_KIND);
  });

  it("asks the real Security gate rather than a private policy", async () => {
    const { registry, catalog } = createCodingToolComposition();
    const gate = toolSecurity().gate;
    expect(gate).toBeInstanceOf(CaelushToolExecutionGate);

    const decide = async (
      toolName: ToolInvocation["toolName"],
      permissionProfile: "READ_ONLY" | "PROJECT_ACCESS" | "FULL_ACCESS",
      approvalPolicy: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK",
    ) => {
      const definition = catalog.get(toolName);
      const resolved = registry.resolve(toolName);
      if (definition === undefined || resolved === undefined) {
        throw new Error(`${toolName} must be registered`);
      }
      return gate.decide({
        invocation: runningInvocation({
          toolName,
          args: {},
          runId: createRunId(),
          stepId: createStepId(),
          // The gate refuses a call whose durable risk level disagrees with the metadata it is asked
          // about, so the invocation carries the catalog's own value.
          riskLevel: definition.security.riskLevel,
        }),
        toolName,
        definition: {
          name: toolName,
          riskLevel: definition.security.riskLevel,
          requiredCapabilities: definition.security.requiredCapabilities,
          runtimeRequirements: definition.security.runtimeRequirements as never,
        },
        securityContext: { permissionProfile, approvalPolicy },
        runtimeKind: "local",
      });
    };

    // A capability-authorized, low-risk structured Tool under `ALWAYS_ASK` is reviewable.
    expect((await decide("list_directory", "READ_ONLY", "ALWAYS_ASK")).kind).toBe(
      "REQUIRE_APPROVAL",
    );
    // `READ_ONLY` grants no process capability, so an unconfined command is denied outright.
    expect((await decide("exec_command", "READ_ONLY", "NEVER_ASK")).kind).toBe("DENY");
    // `FULL_ACCESS` is the profile that may run it without review.
    expect((await decide("exec_command", "FULL_ACCESS", "NEVER_ASK")).kind).toBe("ALLOW");
  });
});
