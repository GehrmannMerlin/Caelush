import { createHash } from "node:crypto";
import type { JsonObject } from "@caelush/ai";
import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createToolInvocationId,
  createWorkspaceId,
  type ToolInvocation,
  type ToolName,
  type WorkflowResourceBindingDraftV1,
} from "@caelush/protocol";
import {
  createToolCallPreparer,
  createToolInvocationExecutor,
  createToolResultPipeline,
  DefaultAgentToolRegistryBuilder,
  type AgentTool,
  type AgentToolRegistry,
  type ToolExecutionIdentity,
} from "@caelush/agent";
import { describe, expect, it, vi } from "vitest";
import {
  createCodingToolCatalog,
  createDefaultCodingTools,
  DEFAULT_CODING_TOOL_ORDER,
  promptSnippetFor,
  type CodingToolDefinition,
  type SkillOperations,
} from "@caelush/coding-agent";

const OLD_TOOL_ORDER = [
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "apply_patch",
  "update_plan",
  "exec_command",
  "write_stdin",
  "stop_process",
  "git_status",
  "git_diff",
  "read_attachment",
  "read_history",
] as const;

const SKILL_TOOL_ORDER = ["search_skills", "read_skill", "run_skill_script"] as const;

// Captured from the pre-05.2 default registry and guidance strings at commit f4c0d5cf.
const OLD_MODEL_SPEC_SHA256 = "5e9df1a8c401f41501f73ad8524b2e15b859b8d679d8a6fd4d747a184856ff8f";
const OLD_PROMPT_SHA256 = "0cd1ea391e09002b75fbd50157f2f7d9d0d96f7a1231f338a33744a12672af2a";

describe("fixed Skill discovery Tools", () => {
  it("keeps OFF at the old thirteen Tools and preserves model and prompt bytes", () => {
    const definitions = createDefaultCodingTools(defaultOperations());
    const registry = registryWith(definitions);

    expect(DEFAULT_CODING_TOOL_ORDER).toEqual(OLD_TOOL_ORDER);
    expect(definitions.map(({ tool }) => tool.name)).toEqual(OLD_TOOL_ORDER);
    expect(hash(registry.modelSpecs())).toBe(OLD_MODEL_SPEC_SHA256);
    expect(
      hash(OLD_TOOL_ORDER.map((name) => ({ name, snippet: promptSnippetFor(name as ToolName) }))),
    ).toBe(OLD_PROMPT_SHA256);
    expect(definitions.some(({ tool }) => tool.name === "search_skills")).toBe(false);
  });

  it("appends the three fixed definitions in order in an isolated ON composition", () => {
    const definitions = createDefaultCodingTools(
      defaultOperations(
        skillOperations({
          search: async () => ({ items: [], inventoryComplete: true }),
          read: async () => {
            throw new Error("not exercised");
          },
        }),
      ),
    );
    const registry = registryWith(definitions);
    const catalog = createCodingToolCatalog({ registry, definitions });

    expect(definitions.map(({ tool }) => tool.name)).toEqual([
      ...OLD_TOOL_ORDER,
      ...SKILL_TOOL_ORDER,
    ]);
    expect(registry.names()).toEqual([...OLD_TOOL_ORDER, ...SKILL_TOOL_ORDER]);
    expect(catalog.names()).toEqual([...OLD_TOOL_ORDER, ...SKILL_TOOL_ORDER]);
    expect(registry.modelSpecs()).toHaveLength(16);
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(Object.isFrozen(definitions.at(-1))).toBe(true);
  });

  it("declares bounded, closed schemas and grants the sidecar capability only to read_skill", () => {
    const definitions = createDefaultCodingTools(defaultOperations(skillOperations()));
    const registry = registryWith(definitions);
    const specs = registry.modelSpecs();
    const search = specs.find(({ name }) => name === "search_skills");
    const read = specs.find(({ name }) => name === "read_skill");
    const script = specs.find(({ name }) => name === "run_skill_script");

    expect(search?.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 256 },
        cursor: { type: "string", maxLength: 2048 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
      },
    });
    expect(read?.inputSchema).toMatchObject({
      type: "object",
      required: ["skillId"],
      additionalProperties: false,
      properties: {
        skillId: { type: "string", minLength: 1, maxLength: 256 },
        resourcePath: { type: "string", maxLength: 1024 },
        cursor: { type: "string", maxLength: 512 },
      },
    });
    expect(script?.inputSchema).toMatchObject({
      type: "object",
      required: ["bindingId", "resourcePath", "args"],
      additionalProperties: false,
      properties: {
        bindingId: { type: "string", minLength: 1, maxLength: 256 },
        resourcePath: { type: "string", minLength: 1, maxLength: 1024 },
        args: { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 } },
      },
    });

    for (const spec of [search, read, script]) {
      expect(spec).toBeDefined();
      expect(Object.keys(spec!).sort()).toEqual(["description", "inputSchema", "name"]);
    }
    const readTool = definitions.find(({ tool }) => tool.name === "read_skill")?.tool as
      (AgentTool & { readonly settlementOutputCapabilities?: readonly string[] }) | undefined;
    expect(readTool?.settlementOutputCapabilities).toEqual(["WORKFLOW_RESOURCE_BINDING"]);
    for (const definition of definitions.filter(({ tool }) => tool.name !== "read_skill")) {
      expect(definition.tool).not.toHaveProperty("settlementOutputCapabilities");
    }
  });

  it("returns only a safe core-read marker while carrying the verified binding outside the result", async () => {
    const runId = createRunId();
    const sourceStepId = createStepId();
    const invocationId = createToolInvocationId();
    const sessionId = createSessionId();
    const artifactRef = "skill-bundle:private-artifact-ref";
    const sourceFingerprint = `sha256:${"a".repeat(64)}`;
    const binding: WorkflowResourceBindingDraftV1 = {
      runId,
      resourceKind: "WORKFLOW_INSTRUCTION",
      resourceId: "skill_frontend",
      resourceRevision: `sha256:${"b".repeat(64)}`,
      artifactRef,
      sourceFingerprint,
      utf8Bytes: 384,
      tokenEstimate: 128,
      sourceToolInvocationId: invocationId,
    };
    const seen: unknown[] = [];
    const definitions = createDefaultCodingTools(
      defaultOperations(
        skillOperations({
          async read(input) {
            seen.push(input);
            return { kind: "CORE_CONTENT_READY", bindingDraft: binding };
          },
        }),
      ),
    );
    const registry = registryWith(definitions);
    const invocation = runningInvocation({ runId, sourceStepId, invocationId, sessionId });
    const output = await executeTool(registry, invocation, {
      toolName: "read_skill",
      args: { skillId: "skill_frontend" },
    });
    const envelope = output as {
      readonly result: {
        readonly content: string;
        readonly details: Record<string, unknown>;
        readonly isError: boolean;
      };
      readonly preparedResourceBindings?: readonly WorkflowResourceBindingDraftV1[];
    };

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ runId, invocationId, skillId: "skill_frontend" });
    expect(envelope.preparedResourceBindings).toEqual([binding]);
    expect(Object.keys(envelope.result).sort()).toEqual(["content", "details", "isError"]);
    expect(envelope.result.content).toMatch(/content is ready/i);
    expect(envelope.result.details).toEqual({ ok: true, state: "CONTENT_READY" });
    expect(JSON.stringify(envelope.result)).not.toContain("private-artifact-ref");
    expect(JSON.stringify(envelope.result)).not.toContain(sourceFingerprint);
    expect(JSON.stringify(envelope.result)).not.toContain("SECRET_SKILL_BODY");

    const prepared = preparedCall(registry, "read_skill", { skillId: "skill_frontend" });
    const outcome = createToolResultPipeline().process({
      call: prepared,
      invocation,
      rawResult: envelope.result as never,
      now: createTimestampMs(2),
    });
    expect(outcome.kind).toBe("ACCEPTED");
    if (outcome.kind === "ACCEPTED") {
      expect(outcome.settlement.result.content).toBe(envelope.result.content);
      expect(JSON.stringify(outcome.settlement)).not.toContain("private-artifact-ref");
      expect(JSON.stringify(outcome.settlement)).not.toContain(sourceFingerprint);
    }
  });

  it("returns bounded supplemental text without producing a core binding", async () => {
    const definitions = createDefaultCodingTools(
      defaultOperations(
        skillOperations({
          async read() {
            return {
              kind: "SUPPLEMENTAL_RESOURCE",
              resource: {
                kind: "TEXT",
                relativePath: "references/guide.md",
                contentType: "text/markdown",
                fingerprint: `sha256:${"c".repeat(64)}`,
                complete: true,
                text: "Supplemental guide text.",
              },
            };
          },
        }),
      ),
    );
    const registry = registryWith(definitions);
    const output = (await executeTool(registry, runningInvocation(), {
      toolName: "read_skill",
      args: { skillId: "skill_frontend", resourcePath: "references/guide.md" },
    })) as {
      readonly result: {
        readonly content: string;
        readonly details: Record<string, unknown>;
        readonly isError: boolean;
      };
    };

    expect(output.result.content).toBe("Supplemental guide text.");
    expect(output.result.details).toMatchObject({
      ok: true,
      state: "RESOURCE_READ",
      resourcePath: "references/guide.md",
    });
    expect(output).not.toHaveProperty("preparedResourceBindings");
  });

  it("refuses to treat a supplemental read request as a core binding", async () => {
    const invocation = runningInvocation();
    const definitions = createDefaultCodingTools(
      defaultOperations(
        skillOperations({
          async read() {
            return {
              kind: "CORE_CONTENT_READY",
              bindingDraft: bindingFor(invocation.runId, invocation.id),
            };
          },
        }),
      ),
    );
    const registry = registryWith(definitions);

    const output = (await executeTool(registry, invocation, {
      toolName: "read_skill",
      args: { skillId: "skill_frontend", resourcePath: "references/guide.md" },
    })) as {
      readonly result: {
        readonly isError: boolean;
        readonly details: Record<string, unknown>;
      };
      readonly preparedResourceBindings?: readonly WorkflowResourceBindingDraftV1[];
    };

    expect(output.result.isError).toBe(true);
    expect(output.result.details).toMatchObject({ ok: false, error: "SKILL_RESOURCE_INVALID" });
    expect(output.preparedResourceBindings).toBeUndefined();
  });

  it("fails a supplemental read over budget instead of returning truncated text", async () => {
    const definitions = createDefaultCodingTools(
      defaultOperations(
        skillOperations({
          async read() {
            return {
              kind: "SUPPLEMENTAL_RESOURCE",
              resource: {
                kind: "TEXT",
                relativePath: "references/large.md",
                contentType: "text/markdown",
                fingerprint: `sha256:${"d".repeat(64)}`,
                complete: true,
                text: "large supplemental text ".repeat(2_000),
              },
            };
          },
        }),
      ),
    );
    const registry = registryWith(definitions);
    const output = (await executeTool(registry, runningInvocation(), {
      toolName: "read_skill",
      args: { skillId: "skill_frontend", resourcePath: "references/large.md" },
    })) as {
      readonly result: {
        readonly content: string;
        readonly details: Record<string, unknown>;
        readonly isError: boolean;
      };
    };

    expect(output.result.isError).toBe(true);
    expect(output.result.details).toMatchObject({ ok: false, error: "SKILL_RESOURCE_INVALID" });
    expect(output.result.content).not.toContain("large supplemental text");
    expect(output).not.toHaveProperty("preparedResourceBindings");
  });

  it("normalizes legacy results and rejects a sidecar from a Tool without the static capability", async () => {
    const ordinaryTool: AgentTool = {
      name: "ordinary_skill_test",
      description: "Test ordinary result boundary.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      label: "Ordinary",
      resultDetailsSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      executionMode: "SEQUENTIAL",
      execute: async () => ({ content: "ok", details: { ok: true }, isError: false }),
    };
    const legacyRegistry = registryWith([
      {
        tool: ordinaryTool,
        security: {
          riskLevel: "LOW",
          requiredCapabilities: [],
          runtimeRequirements: { runtimeKinds: [] },
        },
      },
    ]);
    const legacy = await executeTool(
      legacyRegistry,
      runningInvocation({ toolName: "ordinary_skill_test" }),
      {
        toolName: "ordinary_skill_test",
        args: {},
      },
    );
    expect(legacy).toMatchObject({
      result: { content: "ok", details: { ok: true }, isError: false },
    });
    expect(legacy).not.toHaveProperty("preparedResourceBindings");

    const forgedTool = {
      ...ordinaryTool,
      execute: async () => ({
        result: { content: "ok", details: { ok: true }, isError: false },
        preparedResourceBindings: [bindingFor(createRunId(), createToolInvocationId())],
      }),
    } as unknown as AgentTool;
    const forgedRegistry = registryWith([
      {
        tool: forgedTool,
        security: {
          riskLevel: "LOW",
          requiredCapabilities: [],
          runtimeRequirements: { runtimeKinds: [] },
        },
      },
    ]);
    await expect(
      executeTool(forgedRegistry, runningInvocation({ toolName: "ordinary_skill_test" }), {
        toolName: "ordinary_skill_test",
        args: {},
      }),
    ).rejects.toThrow();
  });

  it("rejects a read sidecar whose bounded byte and token facts disagree", async () => {
    const invocation = runningInvocation();
    const binding = bindingFor(invocation.runId, invocation.id);
    const definitions = createDefaultCodingTools(
      defaultOperations(
        skillOperations({
          async read() {
            return {
              kind: "CORE_CONTENT_READY",
              bindingDraft: { ...binding, tokenEstimate: binding.tokenEstimate - 1 },
            };
          },
        }),
      ),
    );
    const registry = registryWith(definitions);

    await expect(
      executeTool(registry, invocation, {
        toolName: "read_skill",
        args: { skillId: "skill_frontend" },
      }),
    ).rejects.toThrow();
  });

  it("keeps script execution explicitly unavailable in the Phase 05 test composition", async () => {
    const runScript = vi.fn(async () => ({ kind: "UNAVAILABLE" as const }));
    const definitions = createDefaultCodingTools(defaultOperations(skillOperations({ runScript })));
    const script = definitions.find(({ tool }) => tool.name === "run_skill_script")?.tool;
    expect(script).toBeDefined();

    const result = await script!.execute({
      identity: executionIdentityFor(runningInvocation({ toolName: "run_skill_script" })),
      args: { bindingId: "binding_1", resourcePath: "scripts/check.mjs", args: [] },
      environment: environment(),
      signal: new AbortController().signal,
      updates: { publish: () => undefined },
    } as never);

    expect(runScript).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: { error: "SCRIPT_EXECUTION_UNAVAILABLE" },
    });
    expect(JSON.stringify(result)).not.toContain("/workspace");
  });
});

function defaultOperations(skills?: unknown): never {
  return {
    readFile: {},
    readOnly: {},
    patch: {},
    exec: {},
    process: {},
    git: {},
    ...(skills === undefined ? {} : { skills }),
  } as never;
}

function skillOperations(overrides: Partial<SkillOperations> = {}): SkillOperations {
  return {
    async search() {
      return { items: [], inventoryComplete: true };
    },
    async read() {
      throw new Error("Skill read was not expected.");
    },
    async runScript() {
      return { kind: "UNAVAILABLE" };
    },
    ...overrides,
  };
}

function registryWith(definitions: readonly CodingToolDefinition[]): AgentToolRegistry {
  const builder = new DefaultAgentToolRegistryBuilder();
  for (const definition of definitions) builder.register(definition.tool);
  return builder.build();
}

function preparedCall(registry: AgentToolRegistry, toolName: string, args: JsonObject) {
  const outcome = createToolCallPreparer(registry).prepare({
    externalCallId: "call_skill_1",
    toolName: toolName as ToolName,
    args,
  });
  if (outcome.kind !== "READY") throw new Error("Skill Tool arguments were unexpectedly rejected.");
  return outcome.call;
}

async function executeTool(
  registry: AgentToolRegistry,
  invocation: ToolInvocation,
  request: { readonly toolName: string; readonly args: JsonObject },
): Promise<unknown> {
  return await createToolInvocationExecutor({ invocation }).execute({
    call: preparedCall(registry, request.toolName, request.args),
    identity: executionIdentityFor(invocation),
    environment: environment(),
    signal: new AbortController().signal,
  });
}

function runningInvocation(
  input: {
    readonly runId?: ReturnType<typeof createRunId>;
    readonly sourceStepId?: ReturnType<typeof createStepId>;
    readonly invocationId?: ReturnType<typeof createToolInvocationId>;
    readonly sessionId?: ReturnType<typeof createSessionId>;
    readonly toolName?: string;
  } = {},
): ToolInvocation {
  return {
    id: input.invocationId ?? createToolInvocationId(),
    runId: input.runId ?? createRunId(),
    stepId: input.sourceStepId ?? createStepId(),
    toolName: (input.toolName ?? "read_skill") as ToolName,
    externalCallId: "call_skill_1",
    args: {},
    riskLevel: "LOW",
    status: "RUNNING",
    createdAt: createTimestampMs(1),
  };
}

function executionIdentityFor(invocation: ToolInvocation): ToolExecutionIdentity {
  return {
    runId: invocation.runId,
    sessionId: createSessionId(),
    sourceStepId: invocation.stepId,
    invocationId: invocation.id,
    externalCallId: invocation.externalCallId ?? "call_skill_1",
  };
}

function environment() {
  return {
    workspace: { id: createWorkspaceId(), path: "/workspace" },
    runtime: { id: "local", kind: "local" as const },
  };
}

function bindingFor(
  runId: ReturnType<typeof createRunId>,
  sourceToolInvocationId: ReturnType<typeof createToolInvocationId>,
): WorkflowResourceBindingDraftV1 {
  return {
    runId,
    resourceKind: "WORKFLOW_INSTRUCTION",
    resourceId: "skill_frontend",
    resourceRevision: `sha256:${"b".repeat(64)}`,
    artifactRef: "skill-bundle:private-artifact-ref",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    utf8Bytes: 384,
    tokenEstimate: 128,
    sourceToolInvocationId,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
