import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const api = protocol as Record<string, unknown>;
type SchemaLike = {
  parse: (value: unknown) => unknown;
  safeParse: (value: unknown) => { success: boolean };
};

function getSchema(name: string): SchemaLike | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as SchemaLike;
}

function getFactory(name: string): (() => string) | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "function") {
    return undefined;
  }

  return value as () => string;
}

/**
 * The Protocol Tool contracts.
 *
 * ```text
 * ToolNameSchema              a durable identity primitive       retained
 * ToolInvocationSchema        the persisted invocation row       retained, shape unchanged
 * ToolInvocationStatusSchema  the six lifecycle statuses         retained, values unchanged
 * ToolDefinitionSchema        the legacy mixed Tool contract     RETIRED in Phase 4F
 * ```
 *
 * Phase 4F removed `ToolDefinition`/`ToolDefinitionSchema`, which mixed the general model-facing Tool
 * fields with Coding-specific policy metadata. The general contract is now `AgentTool` + `AIToolSpec`
 * in `@caelush/agent`/`@caelush/ai`, and the Coding metadata lives on `CodingToolDefinition.security` in
 * `@caelush/coding-agent`. What remains here is what a **persisted row** actually stores.
 */
describe("protocol tool contracts", () => {
  it("accepts the safe legacy conversation continuity error", () => {
    const codeSchema = getSchema("AgentErrorCodeSchema");
    const errorSchema = getSchema("AgentErrorSchema");
    if (codeSchema === undefined || errorSchema === undefined) return;

    expect(codeSchema.parse("CONVERSATION_CONTINUITY_INCOMPATIBLE")).toBe(
      "CONVERSATION_CONTINUITY_INCOMPATIBLE",
    );
    expect(
      errorSchema.parse({
        code: "CONVERSATION_CONTINUITY_INCOMPATIBLE",
        message: "This conversation cannot safely continue with the selected model.",
        retryable: false,
        phase: "LLM",
        details: { continuityReason: "LEGACY_REPLAY_MISSING" },
      }),
    ).toMatchObject({ code: "CONVERSATION_CONTINUITY_INCOMPATIBLE", retryable: false });
  });

  it("maps built-in Tools to presentation-only categories and defaults unknown Tools safely", () => {
    const category = api["toolPresentationCategory"];
    expect(category).toBeTypeOf("function");
    if (typeof category !== "function") return;

    expect((category as (toolName: string) => string)("read_file")).toBe("READ");
    expect((category as (toolName: string) => string)("find_files")).toBe("SEARCH");
    expect((category as (toolName: string) => string)("apply_patch")).toBe("EDIT");
    expect((category as (toolName: string) => string)("exec_command")).toBe("COMMAND");
    expect((category as (toolName: string) => string)("write_stdin")).toBe("PROCESS");
    expect((category as (toolName: string) => string)("git_status")).toBe("GIT");
    expect((category as (toolName: string) => string)("host_specific_tool")).toBe("OTHER");
  });

  it("parses TOOL_OUTCOME_UNKNOWN as an Agent error without changing Tool statuses", () => {
    const errorCodeSchema = getSchema("AgentErrorCodeSchema");
    const agentErrorSchema = getSchema("AgentErrorSchema");
    const statusSchema = getSchema("ToolInvocationStatusSchema");
    if (
      errorCodeSchema === undefined ||
      agentErrorSchema === undefined ||
      statusSchema === undefined
    ) {
      return;
    }

    expect(errorCodeSchema.parse("TOOL_OUTCOME_UNKNOWN")).toBe("TOOL_OUTCOME_UNKNOWN");
    expect(
      (
        agentErrorSchema.parse({
          code: "TOOL_OUTCOME_UNKNOWN",
          message: "Tool outcome is unknown.",
          retryable: false,
          phase: "RUNTIME",
        }) as { readonly retryable: boolean }
      ).retryable,
    ).toBe(false);
    expect(statusSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  it("parses a durable ToolInvocation and its status set", () => {
    const invocationSchema = getSchema("ToolInvocationSchema");
    const createRunId = getFactory("createRunId");
    const createStepId = getFactory("createStepId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    if (
      invocationSchema === undefined ||
      createRunId === undefined ||
      createStepId === undefined ||
      createToolInvocationId === undefined
    ) {
      return;
    }

    const invocation = {
      id: createToolInvocationId(),
      runId: createRunId(),
      stepId: createStepId(),
      toolName: "read_file",
      externalCallId: "call-1",
      args: { path: "README.md" },
      riskLevel: "LOW",
      status: "REQUESTED",
      createdAt: 1_700_000_000_000,
    };

    expect(invocationSchema.parse(invocation)).toEqual(invocation);

    // The six statuses are the durable lifecycle, and no Phase 4 round added one.
    const statusSchema = getSchema("ToolInvocationStatusSchema");
    if (statusSchema === undefined) return;
    for (const status of [
      "REQUESTED",
      "WAITING_APPROVAL",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]) {
      expect(statusSchema.safeParse(status).success, status).toBe(true);
    }
    expect(statusSchema.safeParse("PENDING").success).toBe(false);
  });

  it("rejects invalid Tool names and non-object arguments", () => {
    const invocationSchema = getSchema("ToolInvocationSchema");
    const nameSchema = getSchema("ToolNameSchema");
    const createRunId = getFactory("createRunId");
    const createStepId = getFactory("createStepId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    if (
      invocationSchema === undefined ||
      nameSchema === undefined ||
      createRunId === undefined ||
      createStepId === undefined ||
      createToolInvocationId === undefined
    ) {
      return;
    }

    // A Tool name is a lowercase identity primitive, and the pattern is unchanged by the retirement.
    expect(nameSchema.safeParse("read_file").success).toBe(true);
    expect(nameSchema.safeParse("Read File").success).toBe(false);
    expect(nameSchema.safeParse("").success).toBe(false);

    expect(
      invocationSchema.safeParse({
        id: createToolInvocationId(),
        runId: createRunId(),
        stepId: createStepId(),
        toolName: "read_file",
        args: ["README.md"],
        riskLevel: "LOW",
        status: "REQUESTED",
        createdAt: 1_700_000_000_000,
      }).success,
    ).toBe(false);
  });

  it("no longer exports the retired legacy ToolDefinition contract", () => {
    // Phase 4F owns this retirement, and it is the only round authorised to make it. A reappearing
    // export would be a second, mixed Tool contract alongside the canonical two-layer one.
    expect(Object.hasOwn(protocol, "ToolDefinitionSchema")).toBe(false);
    expect(api["ToolDefinition"]).toBeUndefined();
  });
});
