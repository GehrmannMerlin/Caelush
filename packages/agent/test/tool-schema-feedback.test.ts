import type { JsonObject } from "@caelush/ai";
import { describe, expect, it } from "vitest";
import {
  DefaultAgentToolRegistryBuilder,
  MAX_MODEL_SCHEMA_FEEDBACK_BYTES,
  MAX_MODEL_SCHEMA_ISSUES,
  createToolCallPreparer,
  renderToolSchemaFeedback,
  type AgentTool,
  type ToolSchemaIssue,
} from "@caelush/agent";

/**
 * What a model is told when its arguments do not match the declared schema.
 *
 * The regression these tests pin is the historical one: a model sent a patch under the wrong field
 * name sixty-four times because the only feedback it received was "correct the reported fields".
 * The requirement is not "a nicer sentence" — it is that the *specific* missing and unsupported
 * fields are visible in the text the model reads, without any argument value or host data joining
 * them.
 */

const CLOSED_PATCH_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    patch: { type: "string", minLength: 1 },
  },
  required: ["patch"],
  additionalProperties: false,
};

function registryWith(
  inputSchema: JsonObject,
  tool: Partial<AgentTool> = {},
): ReturnType<DefaultAgentToolRegistryBuilder["build"]> {
  const builder = new DefaultAgentToolRegistryBuilder();
  builder.register({
    name: "apply_patch",
    description: "Apply a patch document.",
    inputSchema,
    label: "Apply Patch",
    resultDetailsSchema: { type: "object", additionalProperties: false },
    executionMode: "SEQUENTIAL",
    execute: async () => ({ content: "ok", details: {}, isError: false }),
    ...tool,
  });
  return builder.build();
}

function reject(inputSchema: JsonObject, args: JsonObject, tool: Partial<AgentTool> = {}) {
  const preparer = createToolCallPreparer(registryWith(inputSchema, tool));
  const outcome = preparer.prepare({ externalCallId: "call-1", toolName: "apply_patch", args });
  if (outcome.kind !== "REJECTED") throw new Error("expected the call to be rejected");
  return outcome.feedback;
}

describe("model-visible Tool schema feedback", () => {
  it("names the missing field and the unsupported field instead of asking the model to guess", () => {
    const feedback = reject(CLOSED_PATCH_SCHEMA, { input: "*** Begin Patch" });

    expect(feedback.code).toBe("TOOL_ARGUMENT_ERROR");
    expect(feedback.content).toContain("missing required field \"patch\"");
    expect(feedback.content).toContain("unsupported field \"input\"");
    expect(feedback.content).toContain("declared fields are \"patch\"");
    expect(feedback.content).toContain("Nothing was executed");
    // The patch body is never echoed back, and neither is any raw argument JSON.
    expect(feedback.content).not.toContain("*** Begin Patch");
    expect(JSON.stringify(feedback.details)).not.toContain("*** Begin Patch");
  });

  it("keeps a preparation rejection a NO_OBSERVATION: nothing executes", async () => {
    let executions = 0;
    const feedback = reject(CLOSED_PATCH_SCHEMA, { input: "x" }, {
      execute: async () => {
        executions += 1;
        return { content: "ok", details: {}, isError: false };
      },
    });
    await Promise.resolve();
    expect(executions).toBe(0);
    expect(feedback.disposition).toBe("SAFE_FAILURE");
    expect(feedback.blockToolFailures).toBeUndefined();
  });

  it("reports a declared type violation without quoting the value", () => {
    const feedback = reject(
      {
        type: "object",
        properties: { limit: { type: "integer" } },
        required: ["limit"],
        additionalProperties: false,
      } as JsonObject,
      { limit: "not-a-number" },
    );

    expect(feedback.content).toContain('field "limit": expected integer');
    expect(feedback.content).not.toContain("not-a-number");
  });

  it("reports a nested field path and enum members", () => {
    const feedback = reject(
      {
        type: "object",
        properties: {
          options: {
            type: "object",
            properties: { mode: { type: "string", enum: ["FAST", "SAFE"] } },
            required: ["mode"],
            additionalProperties: false,
          },
        },
        required: ["options"],
        additionalProperties: false,
      } as JsonObject,
      { options: { mode: "TURBO" } },
    );

    expect(feedback.content).toContain('field "options.mode": expected one of "FAST", "SAFE"');
  });

  it("does not echo hostile or oversized property names", () => {
    const feedback = renderToolSchemaFeedback({
      toolName: "apply_patch",
      issues: [
        {
          instancePath: "",
          keyword: "additionalProperties",
          message: "must NOT have additional properties",
          property: "sk-\u001b[31msecret\n\u001b[0m",
        },
        {
          instancePath: "",
          keyword: "required",
          message: "must have required property",
          property: "a".repeat(200),
        },
      ],
    });

    expect(feedback).toContain("unsupported extra field");
    expect(feedback).toContain("a required field is missing");
    expect(feedback).not.toContain("secret");
    expect(feedback).not.toContain("\u001b");
    expect(feedback).not.toContain("a".repeat(200));
  });

  it("stays bounded under many issues and still names what is actionable", () => {
    const issues: ToolSchemaIssue[] = Array.from({ length: 16 }, (_unused, index) => ({
      instancePath: `/field${String(index)}`,
      keyword: "type",
      message: "must be string",
      expectedType: "string",
    }));
    issues.unshift({
      instancePath: "",
      keyword: "required",
      message: "must have required property 'patch'",
      property: "patch",
    });

    const feedback = renderToolSchemaFeedback({ toolName: "apply_patch", issues });

    expect(Buffer.byteLength(feedback, "utf8")).toBeLessThanOrEqual(
      MAX_MODEL_SCHEMA_FEEDBACK_BYTES,
    );
    expect(feedback).toContain('missing required field "patch"');
    expect(feedback).toContain("omitted");
    const bulletCount = feedback.split("\n").filter((line) => line.startsWith("field ")).length;
    expect(bulletCount).toBeLessThanOrEqual(MAX_MODEL_SCHEMA_ISSUES);
  });

  it("falls back safely for a keyword it does not model", () => {
    const feedback = renderToolSchemaFeedback({
      toolName: "apply_patch",
      issues: [
        {
          instancePath: "/patch",
          keyword: "pattern\u001b[2J",
          message: "must match pattern",
        },
      ],
    });

    expect(feedback).toContain('field "patch": violates the declared "schema" constraint');
    expect(feedback).not.toContain("\u001b");
  });
});
