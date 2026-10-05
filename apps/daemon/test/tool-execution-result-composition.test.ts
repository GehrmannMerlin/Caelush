import {
  CaelushToolExecutionGate,
  CaelushToolExecutionUpdateSanitizer,
  CaelushToolResultSanitizer,
  createDefaultV1ToolExecutionSecurity,
} from "@caelush/security";
import {
  createToolCallPreparer,
  createToolResultPipeline,
  DefaultAgentToolRegistryBuilder,
  type AgentTool,
} from "@caelush/agent";
import {
  createRunId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  type ToolInvocation,
} from "@caelush/protocol";
import { DEFAULT_CODING_TOOL_ORDER } from "@caelush/coding-agent";
import { describe, expect, it } from "vitest";

import { createCodingToolComposition } from "./support/coding-tool-composition.js";

/**
 * The production result composition the daemon builds.
 *
 * ```text
 * createDefaultV1ToolExecutionSecurity
 *   ├─ CaelushToolResultSanitizer          → the canonical ToolResultPipeline's sanitizer port
 *   ├─ CaelushToolExecutionUpdateSanitizer → the canonical transient update sanitizer port
 *   └─ CaelushToolExecutionGate            → the canonical admission policy
 * ```
 *
 * `apps/daemon/src/daemon-composition.ts` composes exactly these values and passes the first two to
 * `createToolResultPipeline` and `createToolInvocationExecutor`. What this file proves is the part a
 * composition test can prove without dispatching anything: the real Security implementations sit
 * behind the canonical Agent ports and still redact what they always redacted, and the default ten
 * Tools reach the canonical registry unchanged.
 *
 * Phase 4F deleted the legacy `createV1SecureToolDispatcher` this file used to inspect. Every
 * assertion below is re-pointed at the canonical objects the production root now builds; the ones that
 * only read the retired dispatcher's private options are gone with it.
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
  "stop_process",
  "git_status",
  "git_diff",
];

function runningInvocation(
  toolName: ToolInvocation["toolName"],
  args: Record<string, unknown> = { path: "src/index.ts" },
): ToolInvocation {
  return {
    id: createToolInvocationId(),
    runId: createRunId(),
    stepId: createStepId(),
    toolName,
    externalCallId: "call-1",
    args: args as ToolInvocation["args"],
    riskLevel: "LOW",
    status: "RUNNING",
    createdAt: createTimestampMs(1),
  };
}

describe("production secure Tool result composition", () => {
  it("binds the real Security result sanitizer to the canonical result pipeline", () => {
    const security = createDefaultV1ToolExecutionSecurity({
      terminalOutputSanitizer: (value) => value,
    });

    // The port the canonical pipeline consumes *is* the Security implementation, not a private copy.
    expect(security.resultSanitizer).toBeInstanceOf(CaelushToolResultSanitizer);
    // The production gate is the Security one too: admission is not a second policy implementation.
    expect(security.gate).toBeInstanceOf(CaelushToolExecutionGate);
  });

  it("redacts an obvious credential in a Tool result through the real sanitizer", () => {
    const { registry } = createCodingToolComposition();
    const security = createDefaultV1ToolExecutionSecurity({
      terminalOutputSanitizer: (value) => value,
    });
    const pipeline = createToolResultPipeline({ sanitizer: security.resultSanitizer });
    const resolved = registry.resolve("read_file");
    if (resolved === undefined) throw new Error("read_file must be registered");

    const outcome = pipeline.process({
      call: {
        request: {
          externalCallId: "call-1",
          toolName: "read_file",
          args: { path: "src/index.ts" },
        },
        resolved,
        args: { path: "src/index.ts" },
      },
      invocation: runningInvocation("read_file"),
      rawResult: {
        content: "API_KEY=supersecretvalue",
        details: { ok: true },
        isError: false,
      },
      now: createTimestampMs(2),
    });

    expect(outcome.kind).toBe("ACCEPTED");
    if (outcome.kind !== "ACCEPTED") throw new Error("expected sanitized Tool output");
    expect(outcome.settlement.result.content).not.toContain("supersecretvalue");
    expect(outcome.settlement.result.content).toContain("[REDACTED]");
  });

  it.each([250, 500])(
    "preserves all %i list_directory entries through real Security redaction",
    (count) => {
      const { registry } = createCodingToolComposition();
      const resolved = registry.resolve("list_directory");
      if (resolved === undefined) throw new Error("list_directory must be registered");
      const args = { path: ".", offset: 1, limit: count };
      const prepared = createToolCallPreparer(registry).prepare({
        externalCallId: `call_list_${count}`,
        toolName: "list_directory",
        args,
      });
      if (prepared.kind !== "READY") throw new Error("list_directory arguments must be valid");

      const entries = Array.from({ length: count }, (_, index) => ({
        name: `entry-${String(index + 1).padStart(3, "0")}.ts`,
        kind: "FILE",
      }));
      const security = createDefaultV1ToolExecutionSecurity({
        terminalOutputSanitizer: (value) => value,
      });
      const result = createToolResultPipeline({
        sanitizer: security.resultSanitizer,
      }).process({
        call: prepared.call,
        invocation: runningInvocation("list_directory", args),
        rawResult: {
          content: entries.map(({ name }) => name).join("\n"),
          details: {
            ok: true,
            path: ".",
            offset: 1,
            count,
            truncated: true,
            nextOffset: count + 1,
            entries,
          },
          isError: false,
        },
        now: createTimestampMs(2),
      });

      expect(result.kind).toBe("ACCEPTED");
      if (result.kind !== "ACCEPTED")
        throw new Error("expected list_directory output to be accepted");
      const details = result.settlement.result.details;
      expect(Array.isArray(details.entries)).toBe(true);
      expect(details.entries).toHaveLength(count);
      expect(details.entries?.every((entry) => entry !== null && typeof entry === "object")).toBe(
        true,
      );
      expect(details.entries?.at(-1)).toMatchObject({
        name: `entry-${String(count).padStart(3, "0")}.ts`,
      });
      expect(typeof details.nextOffset).toBe("number");
      expect(JSON.stringify(result)).not.toContain("[REDACTED:SCAN_LIMIT]");
    },
  );

  it("materializes a real-Security refusal above the all-or-nothing 4096-node budget", () => {
    const builder = new DefaultAgentToolRegistryBuilder();
    const wideTool: AgentTool = {
      name: "wide_result",
      description: "Test-only wide result Tool.",
      label: "Wide result",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      resultDetailsSchema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "integer" }, maxItems: 5_000 },
        },
        required: ["items"],
        additionalProperties: false,
      },
      executionMode: "SEQUENTIAL",
      execute: async () => ({ content: "unused", details: { items: [] }, isError: false }),
    };
    builder.register(wideTool);
    const registry = builder.build();
    const prepared = createToolCallPreparer(registry).prepare({
      externalCallId: "call_wide_result",
      toolName: "wide_result",
      args: {},
    });
    if (prepared.kind !== "READY") throw new Error("wide_result arguments must be valid");
    const security = createDefaultV1ToolExecutionSecurity({
      terminalOutputSanitizer: (value) => value,
    });

    const outcome = createToolResultPipeline({
      sanitizer: security.resultSanitizer,
    }).process({
      call: prepared.call,
      invocation: runningInvocation("wide_result", {}),
      rawResult: {
        content: "wide output",
        details: { items: Array.from({ length: 4_097 }, (_, index) => index) },
        isError: false,
      },
      now: createTimestampMs(2),
    });

    expect(outcome).toMatchObject({
      kind: "FAILED",
      failure: {
        error: { code: "TOOL_OUTPUT_ERROR" },
        feedback: { code: "TOOL_OUTPUT_ERROR", details: { reason: "SCAN_NODE_LIMIT" } },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("4096");
  });

  it("sends an obvious credential in a transient update through the update sanitizer", () => {
    const sanitizer = new CaelushToolExecutionUpdateSanitizer();
    const updateSanitizer = sanitizer.sanitize({
      toolName: "exec_command",
      invocation: runningInvocation("exec_command"),
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
      invocation: runningInvocation("exec_command"),
      update: { kind: "OUTPUT", stream: "stdout", chunk: "C:\\Users\\someone\\.ssh\\id_rsa" },
    });

    expect(dropped).toBeNull();
  });

  it("passes a harmless transient PROGRESS update through unchanged", () => {
    const sanitizer = new CaelushToolExecutionUpdateSanitizer();
    const sanitized = sanitizer.sanitize({
      toolName: "exec_command",
      invocation: runningInvocation("exec_command"),
      update: { kind: "PROGRESS", message: "halfway", completed: 1, total: 2 },
    });

    expect(sanitized).toEqual({ kind: "PROGRESS", message: "halfway", completed: 1, total: 2 });
  });

  it("composes the ten defaults through the canonical registry unchanged", () => {
    const { registry } = createCodingToolComposition();

    expect(registry.names()).toEqual(EXPECTED_DEFAULT_TOOL_ORDER);
    // The frozen order is the Coding product layer's own declaration, and the registry preserves it.
    expect(registry.names()).toEqual([...DEFAULT_CODING_TOOL_ORDER]);
    expect(registry.size).toBe(10);
    // Names, order and schemas are untouched by this round.
    expect(registry.modelSpecs().map((spec) => spec.name)).toEqual(registry.names());
    for (const name of registry.names()) {
      const spec = registry.modelSpecs().find((entry) => entry.name === name)!;
      expect(Object.keys(spec).sort()).toEqual(["description", "inputSchema", "name"]);
      expect(spec.inputSchema["additionalProperties"]).toBe(false);
    }
  });
});
