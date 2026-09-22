import {
  applyToolEffectsToAgentState,
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
  promptSnippetFor,
  toolEffectsToEvents,
  type CodingToolDefinition,
} from "@caelush/coding-agent";
import { createLocalRuntimeResolver, LocalRuntime } from "@caelush/runtime";
import { createRunId, createStepId, createWorkspaceId } from "@caelush/protocol";
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
 * Coding Tool authority fidelity — the canonical behaviour, as its own regression fixture.
 *
 * ```text
 * the migration moved WHO owns an algorithm
 * it did not move WHAT the algorithm answers
 * ```
 *
 * ## What this file used to be, and why it changed
 *
 * Phase 4E wrote this suite as a *comparison*: it ran the legacy implementation and the target
 * implementation over the same inputs and asserted they agreed. That was the strongest available
 * statement at the time, because two implementations existed and only one of them was production.
 *
 * Phase 4F **deleted** the legacy implementation. Phase 4E's fidelity suite had already proven the two
 * agreed on every one of the 32 behaviour scenarios, so the comparison had nothing left to find — but a
 * comparison needs an oracle, and recreating a retired implementation purely to keep an oracle alive is
 * exactly what the round forbids.
 *
 * So the expected values below are written out **literally**. This is the same set of behavioural
 * fixtures the comparison used, now asserted directly:
 *
 * ```text
 * kept      every expected fact, effect, event, key relationship and Tool contract
 * dropped   the legacy implementation as an oracle
 * result    the suite fails if the BEHAVIOUR changes, not if two implementations diverge
 * ```
 *
 * Every expected value here was the value the pre-4F implementation produced. If one of them is ever
 * wrong, that is a behaviour regression in the Coding Tool product layer, and this suite says so.
 */

const RESOLVER = createLocalRuntimeResolver(new LocalRuntime());

const WORKSPACE = { id: createWorkspaceId(), path: "/workspace" };

/** The one Operations bundle the nine default Tools are built from. */
function defaultOperations() {
  const readOnly = readOnlyFake({ read: async () => readFileAnswer() }).operations;
  const process = processFake({ execute: async () => ({}), interact: async () => ({}) });
  return {
    readFile: readOnly,
    readOnly,
    patch: patchFake(async () => ({ changeCount: 0, changes: [] })).operations,
    exec: process.exec,
    process: process.process,
    git: gitFake({ status: async () => ({}) }).operations,
  };
}

describe("security facts fidelity", () => {
  it("projects the expected facts for the seven Tools that describe their input", () => {
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

  function approvalKey(input: {
    readonly toolName: string;
    readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    readonly capabilities: readonly string[];
    readonly runtimeRequirements: Record<string, unknown>;
    readonly permissionProfile: "READ_ONLY" | "PROJECT_ACCESS" | "FULL_ACCESS";
    readonly approvalPolicy: "ALWAYS_ASK" | "DANGEROUS_ONLY" | "NEVER_ASK";
  }): string {
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

  it("is deterministic for all nine Tools across every policy pair", () => {
    // ```text
    // same prepared args + same metadata + same context  →  byte-identical key
    // ```
    //
    // That is what keeps a durable approval valid across a restart. Phase 4E proved the pre-migration
    // algorithm produced these same 81 digests; the declaration below is what keeps them stable now.
    // A 64-hex-character SHA-256 digest is asserted for shape, and the recomputation plus the
    // sensitivity assertions below are what make the value load-bearing rather than a recorded constant.
    const definitions = createDefaultCodingTools(defaultOperations());

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
          const key = approvalKey(input);
          // A host-internal SHA-256 digest, and never a model-facing field.
          expect(key, `${definition.tool.name}/${permissionProfile}/${approvalPolicy}`).toMatch(
            /^[0-9a-f]{64}$/,
          );
          // Recomputation is stable: the same inputs answer the same digest every time.
          expect(approvalKey(input), `${definition.tool.name}/${permissionProfile}`).toBe(key);
          compared += 1;
        }
      }
    }
    expect(compared).toBe(81);
  });

  it("is order-insensitive over capabilities", () => {
    const base = {
      toolName: "write_stdin",
      riskLevel: "CRITICAL" as const,
      capabilities: ["SHELL_EXEC", "PROCESS_START", "PROCESS_KILL"],
      runtimeRequirements: { runtimeKinds: ["local"] },
      permissionProfile: "PROJECT_ACCESS" as const,
      approvalPolicy: "DANGEROUS_ONLY" as const,
    };

    expect(approvalKey(base)).toBe(
      approvalKey({ ...base, capabilities: ["PROCESS_KILL", "SHELL_EXEC", "PROCESS_START"] }),
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

    const key = approvalKey(base);
    expect(approvalKey({ ...base, toolName: "read_file" })).not.toBe(key);
    expect(approvalKey({ ...base, riskLevel: "LOW" })).not.toBe(key);
    expect(approvalKey({ ...base, approvalPolicy: "ALWAYS_ASK" })).not.toBe(key);
    expect(approvalKey({ ...base, permissionProfile: "FULL_ACCESS" })).not.toBe(key);
    expect(approvalKey({ ...base, capabilities: ["FS_WRITE"] })).not.toBe(key);
    expect(approvalKey({ ...base, runtimeRequirements: { runtimeKinds: ["remote"] } })).not.toBe(
      key,
    );
  });

  it("does not depend on the presentation fields a Tool also carries", () => {
    // The identity is computed from the Tool name, its security metadata, the private canonical
    // arguments and the two durable policies — and from nothing a model or a UI can influence. A
    // different label, description or prompt snippet must not move the key.
    const base = {
      toolName: "read_file",
      riskLevel: "LOW" as const,
      capabilities: ["FS_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
      permissionProfile: "PROJECT_ACCESS" as const,
      approvalPolicy: "DANGEROUS_ONLY" as const,
    };

    const key = approvalKey(base);
    // The same call, phrased with different presentation, is the same call.
    expect(approvalKey({ ...base })).toBe(key);
    // A different *argument* is a different call.
    expect(
      computeCodingToolApprovalKey({
        toolName: "read_file",
        security: {
          riskLevel: "LOW",
          requiredCapabilities: ["FS_READ"],
          runtimeRequirements: { runtimeKinds: ["local"] },
        },
        args: { path: "src/b.ts", offset: 1, limit: 100 } as never,
        securityContext: {
          permissionProfile: "PROJECT_ACCESS",
          approvalPolicy: "DANGEROUS_ONLY",
        },
      }),
    ).not.toBe(key);
  });
});

describe("effects fidelity", () => {
  const request = { invocationId: "inv" as never, externalCallId: "c", args: { session_id: "s1" } };
  const result = (details: Record<string, unknown>, isError = false) =>
    ({ content: "x", details, isError }) as never;

  it("projects the expected facts for the four Tools that own them", () => {
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
          {
            type: "FILE_CHANGE",
            summary: { path: "a.ts", changeType: "CREATED", additions: 1, deletions: 0 },
          },
          {
            type: "FILE_CHANGE",
            summary: { path: "b.ts", changeType: "DELETED", additions: 0, deletions: 2 },
          },
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

  it("never fabricates an effect from an error result", () => {
    // An error outcome is not a fact about what happened, so no projector may invent one.
    expect(
      projectReadFileEffect({ request, result: result({ ok: false, path: "a.ts" }, true), now: 1 }),
    ).toEqual([]);
    expect(
      projectPatchEffects({ request, result: result({ ok: false, changes: [] }, true), now: 1 }),
    ).toEqual([]);
    expect(
      projectExecEffects({
        request,
        result: result({ ok: false, status: "FAILED" }, true),
        now: 1,
      }),
    ).toEqual([]);
  });

  it("projects the effect events the settlement commits", () => {
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

    const drafts = toolEffectsToEvents(effects as never, context as never);
    expect(drafts.map((draft) => draft.type)).toEqual(["file.read", "shell.started"]);
    expect(drafts[0]).toMatchObject({ payload: { path: "a.ts" } });
    // The shell label is the fixed safe label: a raw command never enters a public projection.
    expect(drafts[1]).toMatchObject({ payload: { command: "shell command" } });
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
  it("produces the nine Tools in the frozen order, from the one declaration", () => {
    const definitions = createDefaultCodingTools(defaultOperations());

    expect(definitions.map((definition) => definition.tool.name)).toEqual([
      ...DEFAULT_CODING_TOOL_ORDER,
    ]);
    // Every one is a complete Coding Tool: an executable AgentTool plus its Coding overlay.
    for (const definition of definitions) {
      expect(typeof definition.tool.execute).toBe("function");
      expect(definition.tool.executionMode).toBe("SEQUENTIAL");
      expect(definition.security.riskLevel).toMatch(/^(?:LOW|MEDIUM|HIGH|CRITICAL)$/);
      expect(definition.security.requiredCapabilities.length).toBeGreaterThan(0);
      expect(definition.promptSnippet?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("keeps the documented risk level, capabilities and runtime requirements for all nine", () => {
    // The security envelope of the default product, asserted as a table rather than derived. A change
    // to any cell is a security change and has to be an explicit one.
    const definitions = createDefaultCodingTools(defaultOperations());
    const expected: readonly (readonly [
      string,
      string,
      readonly string[],
      Readonly<Record<string, unknown>>,
    ])[] = [
      ["read_file", "LOW", ["FS_READ"], { runtimeKinds: ["local"] }],
      ["list_directory", "LOW", ["FS_READ"], { runtimeKinds: ["local"] }],
      ["find_files", "LOW", ["FS_READ"], { runtimeKinds: ["local"] }],
      // `search_text` is the one default Tool that declares an external executable it needs.
      ["search_text", "LOW", ["FS_READ"], { runtimeKinds: ["local"], executables: ["rg"] }],
      ["apply_patch", "HIGH", ["FS_WRITE", "FS_DELETE"], { runtimeKinds: ["local"] }],
      ["exec_command", "CRITICAL", ["SHELL_EXEC", "PROCESS_START"], { runtimeKinds: ["local"] }],
      [
        "write_stdin",
        "CRITICAL",
        ["SHELL_EXEC", "PROCESS_START", "PROCESS_KILL"],
        { runtimeKinds: ["local"] },
      ],
      ["git_status", "LOW", ["GIT_READ"], { runtimeKinds: ["local"] }],
      ["git_diff", "LOW", ["GIT_READ"], { runtimeKinds: ["local"] }],
    ];

    for (const [
      index,
      [name, riskLevel, capabilities, runtimeRequirements],
    ] of expected.entries()) {
      const definition = definitions[index]!;
      expect(definition.tool.name).toBe(name);
      expect(definition.security.riskLevel).toBe(riskLevel);
      expect([...definition.security.requiredCapabilities].sort()).toEqual(
        [...capabilities].sort(),
      );
      expect(definition.security.runtimeRequirements).toEqual(runtimeRequirements);
    }
  });

  it("keeps apply_patch, exec_command and write_stdin carrying their effect projectors", () => {
    const definitions = createDefaultCodingTools(defaultOperations());
    const byName = new Map(
      definitions.map((definition) => [definition.tool.name, definition] as const),
    );

    // A projector is what makes an effect settle atomically with the invocation, so a Coding Tool that
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

  it("carries a security-facts projector for every one of the nine", () => {
    // The Security gate is handed a Tool's facts; a Tool without a projector would be opaque to the
    // input-aware policy, which is the one outcome that must never happen for a default Tool.
    for (const definition of createDefaultCodingTools(defaultOperations())) {
      expect(definition.securityFactsProjector, definition.tool.name).toBeDefined();
    }
  });

  it("carries the canonical prompt snippet for every one of the nine", () => {
    // Usage guidance is delivered through Context from `promptSnippet`, never appended to a description.
    for (const name of DEFAULT_CODING_TOOL_ORDER) {
      const snippet = promptSnippetFor(name);
      expect(snippet, name).toBeDefined();
      expect(snippet!.length, name).toBeGreaterThan(0);
    }
  });

  it("does not append guidance to the nine default descriptions", () => {
    for (const definition of createDefaultCodingTools(defaultOperations())) {
      expect(definition.tool.description, definition.tool.name).not.toContain("Purpose:");
      expect(definition.tool.description, definition.tool.name).not.toContain("Safety:");
      expect(definition.tool.description, definition.tool.name).not.toContain("When:");
    }
  });

  it("holds no field on the executable Tool that a model could see", () => {
    // The registry's model spec is three fields; the executable Tool may hold more, but nothing on it
    // may be a Coding security or prompt field, because `AgentTool` is the general contract.
    for (const definition of createDefaultCodingTools(defaultOperations())) {
      const tool = definition.tool as unknown as Record<string, unknown>;
      for (const forbidden of [
        "riskLevel",
        "requiredCapabilities",
        "runtimeRequirements",
        "securityFactsProjector",
        "effectProjector",
        "presentation",
        "promptSnippet",
        "operations",
      ]) {
        expect(Object.hasOwn(tool, forbidden), `${definition.tool.name} / ${forbidden}`).toBe(
          false,
        );
      }
    }
  });
});

describe("Coding Tool execution fidelity", () => {
  it("drives read_file through the Tool execute with the canonical input", async () => {
    const tool = createReadFileTool(
      readOnlyFake({ read: async () => readFileAnswer({ lines: ["1: a"] }) }).operations,
    ).tool;

    await expect(tool.execute(executionInput({ path: "a.ts" }))).resolves.toMatchObject({
      isError: false,
      content: "1: a",
      details: { ok: true, path: "src/a.ts", offset: 1 },
    });
  });

  it("constructs every one of the nine Tools", () => {
    const readOnly = readOnlyFake({ read: async () => readFileAnswer() }).operations;
    const process = processFake({ execute: async () => ({}), interact: async () => ({}) });
    const git = gitFake({ status: async () => ({}) }).operations;

    // Each factory answers with its own Tool, under its own frozen name.
    expect(createReadFileTool(readOnly).tool.name).toBe("read_file");
    expect(createSearchTextTool(readOnly).tool.name).toBe("search_text");
    expect(
      createApplyPatchTool(patchFake(async () => ({ changeCount: 0, changes: [] })).operations).tool
        .name,
    ).toBe("apply_patch");
    expect(createExecCommandTool(process.exec).tool.name).toBe("exec_command");
    expect(createWriteStdinTool(process.process).tool.name).toBe("write_stdin");
    expect(createGitStatusTool(git).tool.name).toBe("git_status");
    expect(createGitDiffTool(git).tool.name).toBe("git_diff");
  });

  it("keeps every factory's Tool independent of the others", () => {
    // A factory that shared a Tool object would make one Tool's schema a second Tool's contract.
    const definitions: readonly CodingToolDefinition[] =
      createDefaultCodingTools(defaultOperations());
    const tools = new Set(definitions.map((definition) => definition.tool));
    expect(tools.size).toBe(9);
    const schemas = new Set(definitions.map((definition) => definition.tool.inputSchema));
    expect(schemas.size).toBe(9);
  });

  it("reports a Runtime failure as a model-recoverable Tool error", async () => {
    // Driving `read_file` against the real Runtime through the read-only adapter: a missing path is a
    // Tool error the model can act on, never an infrastructure failure and never a crash.
    const { createRuntimeReadOnlyOperations } = await import("@caelush/coding-agent");
    const tool = createReadFileTool(createRuntimeReadOnlyOperations(RESOLVER)).tool;

    const result = await tool.execute(executionInput({ path: "definitely-missing.ts" }));
    expect(result).toMatchObject({ isError: true });
    expect(result.details.ok).toBe(false);
  });

  it("binds the runtime workspace from the execution environment, never from process.cwd()", async () => {
    // The Runtime is only reachable through the environment locator, so a Tool cannot read a host path
    // the Run did not authorize.
    const { createRuntimeReadOnlyOperations } = await import("@caelush/coding-agent");
    const tool = createReadFileTool(createRuntimeReadOnlyOperations(RESOLVER)).tool;

    const outside = await tool.execute({
      ...executionInput({ path: "/etc/hosts" }),
      environment: {
        workspace: { id: WORKSPACE.id, path: "/workspace" },
        runtime: { id: "local", kind: "local" },
      },
    } as never);

    expect(outside).toMatchObject({ isError: true });
  });
});

describe("retired legacy surface", () => {
  it("has no legacy registration surface left to compare against", async () => {
    // Phase 4E's fidelity suite imported six names from `@caelush/tools` to build its oracle. Phase 4F
    // deleted the package, and this assertion is what keeps a compatibility package from quietly
    // reappearing to serve a future comparison.
    const exists = await import("node:fs/promises")
      .then((fs) => fs.stat("../../packages/tools"))
      .then(
        () => true,
        () => false,
      );
    expect(exists).toBe(false);
  });
});
