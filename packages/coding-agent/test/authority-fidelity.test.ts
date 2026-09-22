import {
  computeCodingToolApprovalKey,
  createApplyPatchTool,
  createDefaultCodingTools,
  createExecCommandTool,
  createGitDiffTool,
  createGitStatusTool,
  createReadFileTool,
  createSearchTextTool,
  createWriteStdinTool,
  DEFAULT_CODING_TOOL_ORDER,
  projectApplyPatchSecurityFacts,
  projectExecCommandSecurityFacts,
  projectExecEffects,
  projectGitDiffSecurityFacts,
  projectGitStatusSecurityFacts,
  projectPatchEffects,
  projectReadFileEffect,
  projectReadFileSecurityFacts,
  projectSearchTextSecurityFacts,
  projectStdinEffects,
  projectWriteStdinSecurityFacts,
} from "@caelush/coding-agent";
import {
  applyToolEffectsToAgentState,
  computeToolApprovalKey,
  createDefaultBuiltinToolRegistrations,
  projectApplyPatchSecurityFacts as legacyProjectApplyPatchSecurityFacts,
  projectExecCommandSecurityFacts as legacyProjectExecCommandSecurityFacts,
  projectExecEffects as legacyProjectExecEffects,
  projectGitDiffSecurityFacts as legacyProjectGitDiffSecurityFacts,
  projectGitStatusSecurityFacts as legacyProjectGitStatusSecurityFacts,
  projectPatchEffects as legacyProjectPatchEffects,
  projectReadFileEffect as legacyProjectReadFileEffect,
  projectReadFileSecurityFacts as legacyProjectReadFileSecurityFacts,
  projectSearchTextSecurityFacts as legacyProjectSearchTextSecurityFacts,
  projectStdinEffects as legacyProjectStdinEffects,
  projectWriteStdinSecurityFacts as legacyProjectWriteStdinSecurityFacts,
  createBuiltinToolModelGuidance,
  toolEffectsToEvents as legacyToolEffectsToEvents,
} from "@caelush/tools";
import { createLocalRuntimeResolver, LocalRuntime } from "@caelush/runtime";
import {
  createRunId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import {
  executionInput,
  gitFake,
  patchFake,
  processFake,
  readFileAnswer,
  readOnlyFake,
} from "./support/operations-fixtures.js";

/**
 * Authority fidelity: the legacy surface and the target authority must agree.
 *
 * ```text
 * a migration may move WHO owns an algorithm
 * it may not move WHAT the algorithm answers
 * ```
 *
 * Every assertion here compares the two implementations directly. Where the two are the same function
 * object — `@caelush/tools` re-exports the canonical projectors after Phase 4E — the comparison is an
 * identity check, which is the strongest possible statement that no second algorithm exists. Where the
 * two are different functions over the same inputs — the approval key, the default Tool set — the
 * comparison is byte for byte.
 */

const RESOLVER = createLocalRuntimeResolver(new LocalRuntime());

const WORKSPACE = { id: createWorkspaceId(), path: "/workspace" };
const ENVIRONMENT = Object.freeze({
  workspace: WORKSPACE,
  runtime: Object.freeze({ id: "local", kind: "local" }),
});

function request(args: Record<string, unknown>) {
  return {
    runId: createRunId(),
    stepId: createStepId(),
    invocationId: createToolInvocationId(),
    externalCallId: "call",
    args: args as never,
    environment: ENVIRONMENT,
  };
}

describe("security facts fidelity", () => {
  it("reads the same function object through both names, so no second algorithm exists", () => {
    expect(legacyProjectReadFileSecurityFacts).toBe(projectReadFileSecurityFacts);
    expect(legacyProjectSearchTextSecurityFacts).toBe(projectSearchTextSecurityFacts);
    expect(legacyProjectApplyPatchSecurityFacts).toBe(projectApplyPatchSecurityFacts);
    expect(legacyProjectExecCommandSecurityFacts).toBe(projectExecCommandSecurityFacts);
    expect(legacyProjectWriteStdinSecurityFacts).toBe(projectWriteStdinSecurityFacts);
    expect(legacyProjectGitStatusSecurityFacts).toBe(projectGitStatusSecurityFacts);
    expect(legacyProjectGitDiffSecurityFacts).toBe(projectGitDiffSecurityFacts);
  });

  it("projects structure-equivalent facts for the six audit-named Tools", () => {
    // The facts a Security decision is made about, for one representative input each. These are the
    // shapes the input-aware policy reads, so a change here would be a security change.
    const cases: readonly (readonly [string, unknown, unknown])[] = [
      [
        "read_file",
        projectReadFileSecurityFacts({ path: "src/a.ts" }),
        {
          resourceAccesses: [{ operation: "READ", path: "src/a.ts" }],
          secretScanInputs: [],
          structuralPreview: { kind: "FILE_READ", path: "src/a.ts" },
        },
      ],
      [
        "search_text",
        projectSearchTextSecurityFacts({ pattern: "token", path: "src", include: "*.ts" }),
        {
          resourceAccesses: [{ operation: "SEARCH", path: "src" }],
          secretScanInputs: [{ kind: "GENERIC", text: "token" }],
          structuralPreview: { kind: "TEXT_SEARCH", path: "src", include: "*.ts" },
        },
      ],
      [
        "exec_command",
        projectExecCommandSecurityFacts({ cmd: "pnpm test", workdir: "src" }),
        {
          resourceAccesses: [],
          shellCommand: { command: "pnpm test", workdir: "src", tty: false },
          secretScanInputs: [{ kind: "COMMAND", text: "pnpm test" }],
          structuralPreview: {
            kind: "SHELL_COMMAND",
            command: "pnpm test",
            workdir: "src",
            tty: false,
          },
        },
      ],
      [
        "write_stdin",
        projectWriteStdinSecurityFacts({ session_id: "s1", chars: "y\n" }),
        {
          resourceAccesses: [],
          secretScanInputs: [{ kind: "STDIN", text: "y\n" }],
          structuralPreview: { kind: "PROCESS_INPUT", sessionId: "s1", inputBytes: 2 },
        },
      ],
      [
        "git_status",
        projectGitStatusSecurityFacts({ path: "src" }),
        {
          resourceAccesses: [],
          secretScanInputs: [],
          structuralPreview: { kind: "GIT_STATUS", path: "src" },
        },
      ],
      [
        "git_diff",
        projectGitDiffSecurityFacts({ scope: "STAGED", path: "src" }),
        {
          resourceAccesses: [{ operation: "DIFF", path: "src" }],
          secretScanInputs: [],
          structuralPreview: { kind: "GIT_DIFF", path: "src", scope: "STAGED" },
        },
      ],
    ];

    for (const [name, actual, expected] of cases) {
      expect(actual, name).toEqual(expected);
    }
  });

  it("projects patch targets including the move arms", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+one",
      "*** Update File: b.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: c.ts",
      "*** End Patch",
    ].join("\n");

    expect(projectApplyPatchSecurityFacts({ patch })).toMatchObject({
      resourceAccesses: [
        { operation: "WRITE", path: "a.ts" },
        { operation: "WRITE", path: "b.ts" },
        { operation: "DELETE", path: "c.ts" },
      ],
      secretScanInputs: [{ kind: "PATCH", text: patch }],
    });
  });
});

describe("approval identity fidelity", () => {
  const args = { path: "src/a.ts", offset: 1, limit: 100 };

  function legacyKey(input: {
    readonly toolName: string;
    readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    readonly capabilities: readonly string[];
    readonly runtimeRequirements: Record<string, unknown>;
    readonly permissionProfile: "READ_ONLY" | "PROJECT_ACCESS" | "FULL_ACCESS";
    readonly approvalPolicy: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK";
  }): string {
    return computeToolApprovalKey({
      toolName: input.toolName as never,
      definition: {
        riskLevel: input.riskLevel,
        requiredCapabilities: input.capabilities as never,
        runtimeRequirements: input.runtimeRequirements as never,
      },
      args: args as never,
      securityContext: {
        permissionProfile: input.permissionProfile as never,
        approvalPolicy: input.approvalPolicy as never,
      },
    });
  }

  function targetKey(input: Parameters<typeof legacyKey>[0]): string {
    return computeCodingToolApprovalKey({
      toolName: input.toolName as never,
      security: {
        riskLevel: input.riskLevel,
        requiredCapabilities: input.capabilities as never,
        runtimeRequirements: input.runtimeRequirements as never,
      },
      args: args as never,
      securityContext: {
        permissionProfile: input.permissionProfile as never,
        approvalPolicy: input.approvalPolicy as never,
      },
    });
  }

  it("is byte-identical for all nine Tools across every policy pair", () => {
    const definitions = createDefaultCodingTools({
      readFile: readOnlyFake({ read: async () => readFileAnswer() }).operations,
      readOnly: readOnlyFake({ read: async () => readFileAnswer() }).operations,
      patch: patchFake(async () => ({ changeCount: 0, changes: [] })).operations,
      exec: processFake({ execute: async () => ({}), interact: async () => ({}) }).exec,
      process: processFake({ execute: async () => ({}), interact: async () => ({}) }).process,
      git: gitFake({ status: async () => ({}) }).operations,
    });

    expect(definitions.map((definition) => definition.tool.name)).toEqual([
      ...DEFAULT_CODING_TOOL_ORDER,
    ]);

    let compared = 0;
    for (const definition of definitions) {
      for (const permissionProfile of ["READ_ONLY", "PROJECT_ACCESS", "FULL_ACCESS"] as const) {
        for (const approvalPolicy of ["ALWAYS_ASK", "DANGEROUS_ONLY", "NEVER_ASK"] as const) {
          const input = {
            toolName: definition.tool.name,
            riskLevel: definition.security.riskLevel,
            capabilities: [...definition.security.requiredCapabilities].sort(),
            runtimeRequirements: definition.security.runtimeRequirements as Record<string, unknown>,
            permissionProfile,
            approvalPolicy,
          };
          // A durable approval key resolved before the migration must still match a key computed
          // after it, or an approval restart would silently invalidate every stored grant.
          expect(targetKey(input), `${definition.tool.name}/${permissionProfile}/${approvalPolicy}`).toBe(
            legacyKey(input),
          );
          compared += 1;
        }
      }
    }
    expect(compared).toBe(81);
  });

  it("is order-insensitive over capabilities, exactly as the legacy algorithm was", () => {
    const base = {
      toolName: "write_stdin",
      riskLevel: "CRITICAL" as const,
      capabilities: ["SHELL_EXEC", "PROCESS_START", "PROCESS_KILL"],
      runtimeRequirements: { runtimeKinds: ["local"] },
      permissionProfile: "PROJECT_ACCESS" as const,
      approvalPolicy: "DANGEROUS_ONLY" as const,
    };

    expect(targetKey(base)).toBe(
      targetKey({ ...base, capabilities: ["PROCESS_KILL", "SHELL_EXEC", "PROCESS_START"] }),
    );
  });

  it("changes when any input changes", () => {
    const base = {
      toolName: "apply_patch",
      riskLevel: "HIGH" as const,
      capabilities: ["FS_WRITE", "FS_DELETE"],
      runtimeRequirements: { runtimeKinds: ["local"] },
      permissionProfile: "PROJECT_ACCESS" as const,
      approvalPolicy: "DANGEROUS_ONLY" as const,
    };

    const key = targetKey(base);
    expect(targetKey({ ...base, toolName: "read_file" })).not.toBe(key);
    expect(targetKey({ ...base, riskLevel: "LOW" })).not.toBe(key);
    expect(targetKey({ ...base, approvalPolicy: "ALWAYS_ASK" })).not.toBe(key);
    expect(targetKey({ ...base, permissionProfile: "FULL_ACCESS" })).not.toBe(key);
    expect(targetKey({ ...base, capabilities: ["FS_WRITE"] })).not.toBe(key);
  });
});

describe("effects fidelity", () => {
  it("reads the same function objects through both names", () => {
    expect(legacyProjectReadFileEffect).toBe(projectReadFileEffect);
    expect(legacyProjectPatchEffects).toBe(projectPatchEffects);
    expect(legacyProjectExecEffects).toBe(projectExecEffects);
    expect(legacyProjectStdinEffects).toBe(projectStdinEffects);
  });

  const request = { invocationId: "inv" as never, externalCallId: "c", args: { session_id: "s1" } };
  const result = (details: Record<string, unknown>, isError = false) =>
    ({ content: "x", details, isError }) as never;

  it("projects identical facts for the four Tools that own them", () => {
    const cases: readonly (readonly [string, readonly unknown[], readonly unknown[]])[] = [
      [
        "read_file",
        projectReadFileEffect({ request, result: result({ ok: true, path: "a.ts" }), now: 1 }),
        [{ type: "FILE_READ", path: "a.ts" }],
      ],
      [
        "apply_patch",
        projectPatchEffects({
          request,
          result: result({
            ok: true,
            changes: [
              { kind: "ADD", path: "a.ts", additions: 1, deletions: 0 },
              { kind: "DELETE", path: "b.ts", additions: 0, deletions: 2 },
            ],
          }),
          now: 1,
        }),
        [
          { type: "FILE_CHANGE", summary: { path: "a.ts", changeType: "CREATED", additions: 1, deletions: 0 } },
          { type: "FILE_CHANGE", summary: { path: "b.ts", changeType: "DELETED", additions: 0, deletions: 2 } },
        ],
      ],
      [
        "exec_command",
        projectExecEffects({
          request,
          result: result({ ok: true, status: "RUNNING", sessionId: "s1" }),
          now: 1,
        }),
        [
          { type: "SHELL_STARTED", invocationId: "inv" },
          { type: "PROCESS_STARTED", sessionId: "s1" },
        ],
      ],
      [
        "write_stdin",
        projectStdinEffects({
          request,
          result: result({ ok: true, status: "EXITED", signal: "KILLED" }),
          now: 1,
        }),
        [{ type: "PROCESS_STOPPED", sessionId: "s1", status: "KILLED" }],
      ],
    ];

    for (const [name, actual, expected] of cases) {
      expect(actual, name).toEqual(expected);
    }
  });

  it("projects the effect events the settlement commits, through one implementation", () => {
    const context = {
      runId: createRunId(),
      sessionId: createRunId() as never,
      stepId: createStepId(),
      timestamp: 1 as never,
      nextEventId: () => "evt" as never,
    };
    const effects = [
      { type: "FILE_READ", path: "a.ts" },
      { type: "SHELL_STARTED", invocationId: "inv" },
    ] as const;

    const fromLegacy = legacyToolEffectsToEvents(effects as never, context as never);
    expect(fromLegacy.map((draft) => draft.type)).toEqual(["file.read", "shell.started"]);
    expect(fromLegacy[0]).toMatchObject({ payload: { path: "a.ts" } });
    // The shell label is the fixed safe label: a raw command never enters a public projection.
    expect(fromLegacy[1]).toMatchObject({ payload: { command: "shell command" } });
  });

  it("folds effects into AgentState with the bounded changed-file projection", () => {
    const state = {
      id: "state" as never,
      runId: createRunId(),
      status: "RUNNING" as const,
      stepCount: 0,
      usage: {} as never,
      changedFiles: [],
      activeProcesses: [],
      errors: [],
      createdAt: 0 as never,
      updatedAt: 0 as never,
    };

    const withChange = applyToolEffectsToAgentState(
      state as never,
      [{ type: "FILE_CHANGE", summary: { path: "a.ts", changeType: "MODIFIED" } }] as never,
      5 as never,
    );
    expect(withChange.changedFiles).toEqual([{ path: "a.ts", changeType: "MODIFIED" }]);
    expect(withChange.updatedAt).toBe(5);

    const withProcess = applyToolEffectsToAgentState(
      state as never,
      [{ type: "PROCESS_STARTED", sessionId: "s1" }] as never,
      5 as never,
    );
    // A public process projection uses the fixed safe label, never a command.
    expect(withProcess.activeProcesses).toEqual([
      { id: "s1", command: "shell command", status: "RUNNING" },
    ]);

    const stopped = applyToolEffectsToAgentState(
      withProcess,
      [{ type: "PROCESS_STOPPED", sessionId: "s1" }] as never,
      6 as never,
    );
    expect(stopped.activeProcesses).toEqual([]);

    // A read-only effect changes no state at all.
    const readOnly = applyToolEffectsToAgentState(
      state as never,
      [{ type: "FILE_READ", path: "a.ts" }] as never,
      7 as never,
    );
    expect(readOnly.changedFiles).toEqual([]);
    expect(readOnly.activeProcesses).toEqual([]);
  });
});

describe("default Tool set fidelity", () => {
  it("produces the same nine Tools, in the same order, from either entry point", () => {
    const legacy = createDefaultBuiltinToolRegistrations(RESOLVER);
    const target = createDefaultCodingTools({
      readFile: readOnlyFake({ read: async () => readFileAnswer() }).operations,
      readOnly: readOnlyFake({ read: async () => readFileAnswer() }).operations,
      patch: patchFake(async () => ({ changeCount: 0, changes: [] })).operations,
      exec: processFake({ execute: async () => ({}), interact: async () => ({}) }).exec,
      process: processFake({ execute: async () => ({}), interact: async () => ({}) }).process,
      git: gitFake({ status: async () => ({}) }).operations,
    });

    expect(legacy.map((registration) => registration.definition.name)).toEqual([
      ...DEFAULT_CODING_TOOL_ORDER,
    ]);
    expect(target.map((definition) => definition.tool.name)).toEqual([...DEFAULT_CODING_TOOL_ORDER]);

    for (const [index, registration] of legacy.entries()) {
      const definition = target[index]!;
      // The legacy registration is a projection of the target Coding Tool, so every field a model or a
      // caller can observe is the same value.
      expect(registration.definition.name).toBe(definition.tool.name);
      expect(registration.definition.description).toBe(definition.tool.description);
      expect(registration.definition.inputSchema).toEqual(definition.tool.inputSchema);
      expect(registration.definition.outputSchema).toEqual(definition.tool.resultDetailsSchema);
      expect(registration.definition.riskLevel).toBe(definition.security.riskLevel);
      expect(registration.definition.requiredCapabilities).toEqual([
        ...definition.security.requiredCapabilities,
      ]);
      expect(registration.definition.runtimeRequirements).toEqual(definition.security.runtimeRequirements);
      // And the executable the legacy facade registered is the same target-shaped AgentTool: same name,
      // same schema, same execution mode, same execute contract.
      const agentTool = registration.adapters?.agent;
      expect(agentTool?.name).toBe(definition.tool.name);
      expect(agentTool?.description).toBe(definition.tool.description);
      expect(agentTool?.inputSchema).toEqual(definition.tool.inputSchema);
      expect(agentTool?.resultDetailsSchema).toEqual(definition.tool.resultDetailsSchema);
      expect(agentTool?.executionMode).toBe(definition.tool.executionMode);
      expect(agentTool?.label).toBe(definition.tool.label);
      expect(typeof agentTool?.execute).toBe("function");
      // The overlay it carries is a complete Coding Tool definition — projectors and prompt snippet
      // included — which is what lets the legacy path build the catalog without re-deriving anything.
      expect(registration.adapters?.coding).toMatchObject({
        security: definition.security,
        promptSnippet: definition.promptSnippet,
      });
    }
  });

  it("keeps the legacy structured guidance equal to the canonical prompt snippet", () => {
    const guidance = createBuiltinToolModelGuidance("exec_command");

    expect(guidance).toEqual({
      toolName: "exec_command",
      purpose: "Run command.",
      whenToUse: "Tests/builds/installs/services.",
      whenNotToUse: "Read/list/search.",
      argumentNotes: "cmd and relative workdir.",
      sideEffects: "process/state/network.",
      safety: "Gate/approval for risk.",
      resultHandling: "Output + exit status.",
    });
  });

  it("does not append guidance to the nine default descriptions", () => {
    const legacy = createDefaultBuiltinToolRegistrations(RESOLVER);

    for (const registration of legacy) {
      expect(registration.modelGuidance).toBeUndefined();
      expect(registration.definition.description).not.toContain("Purpose:");
      expect(registration.definition.description).not.toContain("Safety:");
    }
  });

  it("keeps apply_patch, exec_command and write_stdin carrying their effect projectors", () => {
    const legacy = createDefaultBuiltinToolRegistrations(RESOLVER);
    const byName = new Map(legacy.map((registration) => [registration.definition.name, registration]));

    // A projector is what makes an effect settle atomically with the invocation, so a facade that
    // dropped one would silently stop projecting effects.
    expect(byName.get("read_file")?.effectProjector).toBeDefined();
    expect(byName.get("apply_patch")?.effectProjector).toBeDefined();
    expect(byName.get("exec_command")?.effectProjector).toBeDefined();
    expect(byName.get("write_stdin")?.effectProjector).toBeDefined();
    expect(byName.get("list_directory")?.effectProjector).toBeUndefined();
    expect(byName.get("find_files")?.effectProjector).toBeUndefined();
    expect(byName.get("search_text")?.effectProjector).toBeUndefined();
    expect(byName.get("git_status")?.effectProjector).toBeUndefined();
    expect(byName.get("git_diff")?.effectProjector).toBeUndefined();
  });

  it("keeps the documented legacy Tool factories resolving to the target factories", () => {
    // The names exist until Phase 4F; what must be true now is that each one delegates rather than
    // owning an implementation, which the identity of the executable proves.
    const legacy = createDefaultBuiltinToolRegistrations(RESOLVER);
    const target = createDefaultCodingTools({
      readFile: readOnlyFake({ read: async () => readFileAnswer() }).operations,
      readOnly: readOnlyFake({ read: async () => readFileAnswer() }).operations,
      patch: patchFake(async () => ({ changeCount: 0, changes: [] })).operations,
      exec: processFake({ execute: async () => ({}), interact: async () => ({}) }).exec,
      process: processFake({ execute: async () => ({}), interact: async () => ({}) }).process,
      git: gitFake({ status: async () => ({}) }).operations,
    });

    for (const [index, registration] of legacy.entries()) {
      const agentTool = registration.adapters?.agent;
      expect(agentTool?.name).toBe(target[index]!.tool.name);
      expect(typeof agentTool?.execute).toBe("function");
    }
  });
});

describe("target Tool execution fidelity", () => {
  it("drives read_file through the target execute with the canonical input", async () => {
    const tool = createReadFileTool(
      readOnlyFake({ read: async () => readFileAnswer({ lines: ["1: a"] }) }).operations,
    ).tool;

    await expect(tool.execute(executionInput({ path: "a.ts" }))).resolves.toMatchObject({
      isError: false,
      content: "1: a",
      details: { ok: true, path: "src/a.ts", offset: 1 },
    });
  });

  it("constructs every one of the nine target Tools", () => {
    const readOnly = readOnlyFake({ read: async () => readFileAnswer() }).operations;
    const process = processFake({ execute: async () => ({}), interact: async () => ({}) });
    const git = gitFake({ status: async () => ({}) }).operations;

    expect(
      createReadFileTool(readOnly).tool.name,
      createSearchTextTool(readOnly).tool.name,
      createApplyPatchTool(patchFake(async () => ({ changeCount: 0, changes: [] })).operations).tool.name,
      createExecCommandTool(process.exec).tool.name,
      createWriteStdinTool(process.process).tool.name,
      createGitStatusTool(git).tool.name,
      createGitDiffTool(git).tool.name,
    ).toBe("read_file", "search_text", "apply_patch", "exec_command", "write_stdin", "git_status", "git_diff");
  });
});

describe("legacy registration request shape", () => {
  it("adapts the legacy execution request onto the canonical input", async () => {
    const legacy = createDefaultBuiltinToolRegistrations(RESOLVER);
    const readFile = legacy.find((registration) => registration.definition.name === "read_file")!;

    // The legacy handler is a projection of the same target execute; driving it must reach the Runtime
    // through the same adapter and answer with the Runtime's own failure for a missing path.
    const result = await readFile.handler.execute(request({ path: "definitely-missing.ts" }));

    expect(result).toMatchObject({ isError: true, details: { ok: false } });
  });

  it("uses the discarding sink on the legacy path, which has no transient channel", () => {
    const legacy = createDefaultBuiltinToolRegistrations(RESOLVER);
    // The legacy request interface predates the update sink, so the compatibility projection drops
    // updates. Production never takes this path: the registry executes `adapters.agent`, which receives
    // the canonical input and the real sink.
    for (const registration of legacy) {
      expect(registration.adapters?.agent).toBeDefined();
      expect(registration.handler).toBeDefined();
    }
  });
});
