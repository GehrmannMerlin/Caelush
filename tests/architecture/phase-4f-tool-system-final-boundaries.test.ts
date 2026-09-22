import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4F — the final Tool System V2 ownership guard.
 *
 * ```text
 * AI ToolCall
 *   ↓
 * ToolCallPreparer                  @caelush/agent
 *   ↓
 * ToolBatchCoordinator              @caelush/agent
 *   ↓
 * DurableToolExecutionCoordinator   @caelush/agent      the Tool Invocation Lifecycle Authority
 *   ↓
 * ToolAdmissionCoordinator          @caelush/agent
 *   ↓
 * Coding AgentTool                  @caelush/coding-agent
 *   ↓
 * Operations port → Runtime adapter @caelush/coding-agent → @caelush/runtime
 *   ↓
 * ToolResultPipeline                @caelush/agent
 *   ↓
 * ToolSettlementCoordinator         @caelush/agent
 *   ↓
 * ModelToolFeedbackProjector        @caelush/agent
 * ```
 *
 * This is the *whole-phase* guard. Each Phase 4 round shipped its own boundary guard for the
 * transition it performed; this one asserts the state all six rounds add up to, and it is written to
 * fail if any of the migration-era surfaces quietly returns.
 *
 * ## What "retired" means here, precisely
 *
 * ```text
 * a directory that must not exist         packages/tools
 * an import that must not exist           "@caelush/tools" anywhere in active source
 * a contract that must not exist          protocol.ToolDefinition, protocol.ToolDefinitionSchema
 * a declaration that must not exist       any second Tool execution, batch, lifecycle, feedback,
 *                                         Coding builtin, security-fact, approval-identity or effect
 *                                         authority
 * ```
 *
 * Historical Markdown under `docs/` is explicitly **not** in scope: the Phase 4A–4E reports are
 * evidence of what those rounds did, and they must keep saying it. Only active source is guarded.
 */

const repositoryRoot = process.cwd();

function abs(...parts: readonly string[]): string {
  return path.join(repositoryRoot, ...parts);
}

async function read(relativePath: string): Promise<string> {
  return await readFile(abs(relativePath), "utf8");
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(abs(relativePath));
    return true;
  } catch {
    return false;
  }
}

/** Source with comments removed, so documentation about a forbidden pattern is not a violation. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * This guard's own path.
 *
 * It is excluded from the whole-workspace scans below, because asserting "nothing may name the retired
 * package" requires *naming* it. A guard that fails on itself cannot guard anything.
 */
const SELF = "tests/architecture/phase-4f-tool-system-final-boundaries.test.ts";

/** Active source only: no build output, no dependencies, no historical Markdown, not this guard. */
async function activeSourceFiles(roots: readonly string[]): Promise<readonly string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    if (!(await exists(root))) continue;
    await collect(root, found);
  }
  found.delete(SELF);
  // Sorted so a failing assertion names the same file every run, and de-duplicated so a caller that
  // passes overlapping roots cannot make one file look like two declarations.
  return [...found].sort();
}

async function collect(relativeDir: string, into: Set<string>): Promise<void> {
  for (const entry of await readdir(abs(relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      await collect(relative, into);
    } else if (/\.(?:ts|tsx|js|mjs|cjs|jsx)$/.test(entry.name)) {
      into.add(relative);
    }
  }
}

const WORKSPACE_SOURCE_ROOTS = ["apps", "packages", "tests", "scripts"] as const;

/** Every workspace manifest, so a dependency edge can be asserted absent. */
async function manifestPaths(): Promise<readonly string[]> {
  const found: string[] = ["package.json"];
  for (const group of ["packages", "apps"]) {
    if (!(await exists(group))) continue;
    for (const entry of await readdir(abs(group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = `${group}/${entry.name}/package.json`;
      if (await exists(manifest)) found.push(manifest);
    }
  }
  return found;
}

/** One source file, or "" when the path does not exist. Guards must assert absence, not throw. */
async function sourceOrEmpty(relativePath: string): Promise<string> {
  return (await exists(relativePath)) ? code(await read(relativePath)) : "";
}

/**
 * Every production source file's comment-stripped text, read once.
 *
 * Several assertions below scan all of `packages` and `apps`, and the suite runs beside the whole
 * workspace's test run. Reading a few hundred files concurrently and once — rather than sequentially and
 * once per assertion — is what keeps a whole-repository guard inside the default test timeout.
 */
let sourceCache: Map<string, string> | undefined;

async function executableSources(): Promise<Map<string, string>> {
  if (sourceCache === undefined) {
    const files = (await activeSourceFiles(["packages", "apps"])).filter(
      (file) => !file.includes("/test/"),
    );
    const entries = await Promise.all(
      files.map(async (file) => [file, code(await read(file))] as const),
    );
    sourceCache = new Map(entries);
  }
  return sourceCache;
}

/**
 * Every production source file that contains a declaration.
 *
 * Tests are excluded on purpose: a guard that asserts "nobody else declares this" must not treat a
 * fixture as a second implementation, or the rule becomes unfalsifiable in the other direction.
 */
async function declarationHolders(declaration: string): Promise<readonly string[]> {
  const holders: string[] = [];
  for (const [file, text] of await executableSources()) {
    if (text.includes(declaration)) holders.push(file);
  }
  return holders.sort();
}

const NINE = [
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "git_status",
  "git_diff",
] as const;

describe("Phase 4F guard — the legacy package is gone", () => {
  it("has no packages/tools directory at all", async () => {
    expect(await exists("packages/tools")).toBe(false);
    expect(await exists("packages/tools/package.json")).toBe(false);
    expect(await exists("packages/tools/src/index.ts")).toBe(false);
    expect(await exists("packages/tools/src")).toBe(false);
  });

  it("declares no workspace dependency on @caelush/tools", async () => {
    for (const manifestPath of await manifestPaths()) {
      const manifest = JSON.parse(await read(manifestPath)) as Record<string, unknown>;
      const edges = [
        manifest["dependencies"],
        manifest["devDependencies"],
        manifest["peerDependencies"],
        manifest["optionalDependencies"],
      ];
      for (const edge of edges) {
        if (edge === null || typeof edge !== "object") continue;
        expect(
          Object.keys(edge).includes("@caelush/tools"),
          `${manifestPath} declares @caelush/tools`,
        ).toBe(false);
      }
      // And the retired package must not come back under its own name either.
      expect(manifest["name"], manifestPath).not.toBe("@caelush/tools");
    }
  });

  it("imports the retired package from nowhere in active source", async () => {
    // `code()` strips comments first, so a migration record that *describes* the retired package is not
    // an import of it. What must not exist is a live module specifier, in any import form.
    const retiredSpecifier = ["@caelush", "tools"].join("/");
    const offenders: string[] = [];
    for (const file of await activeSourceFiles(WORKSPACE_SOURCE_ROOTS)) {
      // The architecture guards are excluded, and they are the only exclusion. Several of them name the
      // retired specifier *in an assertion*, which is how they keep it retired; a guard cannot both
      // forbid a string and be forbidden from containing it.
      if (file.startsWith("tests/architecture/")) continue;
      if (code(await read(file)).includes(retiredSpecifier)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("has no cross-package deep import into the retired package", async () => {
    const retiredDeepPath = ["packages", "tools", "src"].join("/");
    const offenders: string[] = [];
    for (const file of await activeSourceFiles(WORKSPACE_SOURCE_ROOTS)) {
      if (file.startsWith("tests/architecture/")) continue;
      if (code(await read(file)).includes(retiredDeepPath)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Phase 4F guard — protocol.ToolDefinition is retired", () => {
  it("exports neither ToolDefinitionSchema nor ToolDefinition from the Protocol package", async () => {
    const toolModule = code(await read("packages/protocol/src/tool.ts"));
    expect(toolModule).not.toContain("ToolDefinitionSchema");
    expect(toolModule).not.toContain("export type ToolDefinition");

    const protocolIndex = code(await read("packages/protocol/src/index.ts"));
    expect(protocolIndex).not.toContain("ToolDefinitionSchema");
    expect(protocolIndex).not.toContain(" ToolDefinition,");
    expect(protocolIndex).not.toContain("ToolDefinition }");
  });

  it("keeps the durable Tool primitives the retirement must not touch", async () => {
    const toolModule = code(await read("packages/protocol/src/tool.ts"));
    expect(toolModule).toContain("export const ToolNameSchema = z");
    expect(toolModule).toContain("export const ToolInvocationSchema = z");
    expect(toolModule).toContain("export const ToolInvocationStatusSchema = z");
    // The persisted shape is unchanged: no field was added, removed or renamed by Phase 4F.
    for (const field of [
      "id: ToolInvocationIdSchema",
      "runId: RunIdSchema",
      "stepId: StepIdSchema",
      "toolName: ToolNameSchema",
      "args: JsonObjectSchema",
      "riskLevel: RiskLevelSchema",
      "status: ToolInvocationStatusSchema",
      "createdAt: TimestampMsSchema",
    ]) {
      expect(toolModule, field).toContain(field);
    }
    // And the six statuses are untouched.
    for (const status of [
      "REQUESTED",
      "WAITING_APPROVAL",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ]) {
      expect(toolModule, status).toContain(`"${status}"`);
    }
  });

  it("has no production consumer of a legacy protocol ToolDefinition", async () => {
    for (const [file, text] of await executableSources()) {
      // `CodingToolDefinition` is the live name and must not be caught by this rule.
      const withoutCoding = text.replaceAll("CodingToolDefinition", "");
      expect(withoutCoding, file).not.toMatch(/(?<![A-Za-z])ToolDefinition(?![A-Za-z])/);
    }
  });
});

describe("Phase 4F guard — one authority per responsibility", () => {
  it("declares the general Agent Tool Kernel exactly once, in @caelush/agent", async () => {
    const declarations: readonly (readonly [string, string])[] = [
      ["export interface AgentTool<", "packages/agent/src/tools/types/agent-tool.ts"],
      ["export interface AgentToolRegistry {", "packages/agent/src/tools/registry/registry.ts"],
      [
        "export function createToolCallPreparer(",
        "packages/agent/src/tools/call/tool-call-preparer-impl.ts",
      ],
      [
        "export function createToolInvocationExecutor(",
        "packages/agent/src/tools/execution/invocation-executor.ts",
      ],
      [
        "export function createToolResultPipeline(",
        "packages/agent/src/tools/result/result-pipeline.ts",
      ],
      [
        "export function createToolSettlementCoordinator(",
        "packages/agent/src/tools/durable/settlement-coordinator.ts",
      ],
      [
        "export function createDurableToolExecutionCoordinator(",
        "packages/agent/src/tools/durable/durable-execution-coordinator.ts",
      ],
      [
        "export function createToolBatchCoordinator(",
        "packages/agent/src/tools/batch/batch-coordinator.ts",
      ],
      [
        "export function createModelToolFeedbackProjector(",
        "packages/agent/src/tools/observation/model-feedback-projector.ts",
      ],
      [
        "export function createToolResultBatchNormalizer(",
        "packages/agent/src/tools/observation/result-batch-normalizer.ts",
      ],
    ];

    for (const [declaration, expectedFile] of declarations) {
      expect(await declarationHolders(declaration), declaration).toEqual([expectedFile]);
    }
  });

  it("declares the nine Coding builtins exactly once, in @caelush/coding-agent", async () => {
    for (const name of NINE) {
      const holders = await declarationHolders(`name: "${name}"`);
      expect(holders, name).toEqual([
        `packages/coding-agent/src/tools/builtins/${name.replaceAll("_", "-")}.ts`,
      ]);
    }
  });

  it("declares the Coding product assets only in @caelush/coding-agent", async () => {
    const codingAssets: readonly (readonly [string, string])[] = [
      [
        "export function computeCodingToolApprovalKey(",
        "packages/coding-agent/src/tools/security/approval-identity.ts",
      ],
      [
        "export function projectReadFileSecurityFacts(",
        "packages/coding-agent/src/tools/security/security-facts.ts",
      ],
      [
        "export function projectReadFileEffect(",
        "packages/coding-agent/src/tools/effects/effect-projectors.ts",
      ],
      [
        "export function applyToolEffectsToAgentState(",
        "packages/coding-agent/src/tools/effects/state-projector.ts",
      ],
      [
        "export function toolEffectsToEvents(",
        "packages/coding-agent/src/tools/effects/event-projector.ts",
      ],
      [
        "export function createToolPromptContextProvider(",
        "packages/coding-agent/src/tools/prompt/tool-prompt-context-provider.ts",
      ],
      [
        "export function createCodingToolAdmissionPort(",
        "packages/coding-agent/src/tools/admission/tool-admission-port.ts",
      ],
      [
        "export function createCodingToolDurableMetadataPort(",
        "packages/coding-agent/src/tools/admission/tool-admission-port.ts",
      ],
      [
        "export function createDurableInvocationGatePort(",
        "packages/coding-agent/src/tools/admission/tool-admission-port.ts",
      ],
    ];

    for (const [declaration, expectedFile] of codingAssets) {
      expect(await declarationHolders(declaration), declaration).toEqual([expectedFile]);
    }
  });

  it("keeps the security-facts vocabulary in exactly one package", async () => {
    expect(await declarationHolders("export interface ToolSecurityFacts {")).toEqual([
      "packages/coding-agent/src/tools/security/security-facts.ts",
    ]);
  });

  it("keeps the durable security context in exactly one package", async () => {
    expect(await declarationHolders("export interface ToolSecurityContext {")).toEqual([
      "packages/agent/src/tools/admission/security-context.ts",
    ]);
  });
});

describe("Phase 4F guard — no reverse legacy dependency", () => {
  it("keeps every package that once depended on the legacy Tool System clean", async () => {
    for (const packageName of [
      "agent",
      "coding-agent",
      "core",
      "security",
      "storage",
      "verification",
      "context",
      "runtime",
      "protocol",
    ]) {
      const manifestPath = `packages/${packageName}/package.json`;
      const manifest = JSON.parse(await read(manifestPath)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(manifest.dependencies?.["@caelush/tools"], manifestPath).toBeUndefined();
      expect(manifest.devDependencies?.["@caelush/tools"], manifestPath).toBeUndefined();
    }
    const daemonManifest = JSON.parse(await read("apps/daemon/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(daemonManifest.dependencies?.["@caelush/tools"]).toBeUndefined();
    expect(daemonManifest.devDependencies?.["@caelush/tools"]).toBeUndefined();
  });

  it("keeps the Coding product layer one-way off the Agent Kernel", async () => {
    const coding = JSON.parse(await read("packages/coding-agent/package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(coding.dependencies?.["@caelush/agent"]).toBe("workspace:*");

    const agent = JSON.parse(await read("packages/agent/package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(agent.dependencies?.["@caelush/coding-agent"]).toBeUndefined();
    // The Kernel may depend only on the AI core contract and Protocol (plus `ajv` for the schema
    // runtime). Any Caelush feature package here would be a reverse edge.
    const forbidden = [
      "@caelush/coding-agent",
      "@caelush/core",
      "@caelush/runtime",
      "@caelush/storage",
      "@caelush/security",
      "@caelush/context",
      "@caelush/verification",
      "@caelush/llm",
    ];
    for (const name of forbidden) {
      expect(agent.dependencies?.[name], name).toBeUndefined();
    }
  });
});

describe("Phase 4F guard — the legacy declarations do not exist", () => {
  it("has no ToolDispatcher implementation anywhere", async () => {
    // Production source, which is where a second lifecycle implementation could actually run. The
    // architecture guards are excluded because several of them *assert* the string is absent.
    for (const file of await activeSourceFiles(["packages", "apps"])) {
      // Comments stripped: a composition root or a migration record legitimately *describes* the
      // dispatcher it retired, and describing it is not implementing it.
      const text = code(await read(file));
      expect(text, file).not.toContain("class ToolDispatcher");
      expect(text, file).not.toContain("new ToolDispatcher(");
    }
  });

  it("has no second batch authority", async () => {
    for (const [file, text] of await executableSources()) {
      expect(text, file).not.toContain("class ToolBatchCoordinator");
      expect(text, file).not.toContain("new ToolBatchCoordinator(");
      expect(text, file).not.toContain("interface ToolBatchItemResult");
    }
  });

  it("has no legacy registry, preflight, failure-memory or execution-store facade", async () => {
    for (const [file, text] of await executableSources()) {
      for (const dead of [
        "class ToolRegistryBuilder",
        "class ToolPreflight",
        "class ToolFailureMemory",
        "interface ToolRegistration",
        "createLegacyToolSettlementExtensionDecoder",
        "createLegacyToolSettlementExtensionProjector",
        "LegacySettlementExtensionError",
        "toLegacyToolExecutionStore",
        "toCanonicalApprovalLookup",
        "toCanonicalToolBudgetPort",
      ]) {
        expect(text, `${file} / ${dead}`).not.toContain(dead);
      }
    }
  });

  it("declares the durable Tool execution conflicts in exactly one place", async () => {
    // `@caelush/security` legitimately names these classes in prose and re-exports nothing of the sort:
    // a second *declaration* would be a competing durable-error authority.
    const conflictHolders = await declarationHolders("export class ToolExecutionConflictError");
    const invariantHolders = await declarationHolders("export class ToolExecutionInvariantError");
    expect(conflictHolders).toEqual(["packages/agent/src/tools/durable/durable-errors.ts"]);
    expect(invariantHolders).toEqual(["packages/agent/src/tools/durable/durable-errors.ts"]);
  });

  it("has no second durable-invocation or model-feedback authority", async () => {
    // One class/factory per responsibility: a second `createDurableToolExecutionCoordinator` or
    // `createModelToolFeedbackProjector` outside the Agent package would be a competing authority.
    for (const factory of [
      "export function createDurableToolExecutionCoordinator(",
      "export function createModelToolFeedbackProjector(",
      "export function createToolResultBatchNormalizer(",
      "export function createToolSettlementCoordinator(",
      "export function createToolInvocationExecutor(",
      "export function createToolResultPipeline(",
    ]) {
      const holders = await declarationHolders(factory);
      expect(holders.length, factory).toBe(1);
      expect(holders[0], factory).toContain("packages/agent/src/");
    }
  });
});

describe("Phase 4F guard — Runtime isolation", () => {
  it("keeps the broad Runtime capability out of the Coding builtins", async () => {
    const files = await activeSourceFiles(["packages/coding-agent/src/tools/builtins"]);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = code(await read(file));
      for (const forbidden of [
        "RuntimeResolver",
        "RuntimeWorkspaceScope",
        "RuntimeFileSystem",
        "RuntimeGitService",
        "RuntimeExecService",
        "resolveRuntimeWorkspace",
        "node:fs",
        "node:child_process",
      ]) {
        expect(text, `${file} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("confines the broad Runtime capability to the Operations adapters", async () => {
    // Scoped to the Coding product layer: the composition root legitimately holds a `RuntimeResolver`
    // to build the adapters, and that is the layer whose *Tools* must not see one.
    const holders: string[] = [];
    for (const [file, text] of await executableSources()) {
      if (!file.startsWith("packages/coding-agent/src/")) continue;
      if (text.includes("RuntimeResolver") || text.includes("RuntimeWorkspaceScope")) {
        holders.push(file);
      }
    }
    const unique = [...new Set(holders)].sort();
    expect(unique.length).toBeGreaterThan(0);
    for (const holder of unique) {
      expect(holder, holder).toContain(
        "packages/coding-agent/src/tools/operations/runtime-adapters/",
      );
    }
  });
});

describe("Phase 4F guard — prompt, effects and cancellation boundaries", () => {
  it("keeps Coding prompt guidance out of AIToolSpec.description", async () => {
    // Production source only: the architecture guards name these symbols in order to assert they are
    // gone, and a guard cannot both forbid a string and be forbidden from containing it.
    for (const [file, text] of await executableSources()) {
      for (const dead of [
        "appendToolModelGuidance",
        "createBuiltinToolModelGuidance",
        "normalizeToolModelGuidance",
      ]) {
        expect(text, `${file} / ${dead}`).not.toContain(dead);
      }
    }
    // The one production delivery path is the Context provider.
    const composition = code(await read("apps/daemon/src/daemon-composition.ts"));
    expect(composition).toContain("createToolPromptContextProvider()");
  });

  it("keeps the Agent layer unable to interpret a Coding Tool effect", async () => {
    // The Kernel carries a settlement extension opaquely: it must not know a Coding effect, a Coding
    // overlay type, a Coding prompt snippet or a Coding facts projector by name.
    //
    // Three deliberate non-violations are stated rather than left implicit:
    //   `riskLevel`            a Protocol v1 persisted `ToolInvocation` field. Two admission modules
    //                         own the durable-metadata seam for it; nothing else in the Tool namespace
    //                         may name it, and the Agent layer never learns what a capability *means*.
    //   the gate metadata      the four policy fields a Security evaluator is asked about, declared by
    //                         the gate contract for the Coding/Security translation to consume. It is a
    //                         Protocol-shaped subset, not the Coding overlay.
    //   `AgentTool`'s own doc  states what an AgentTool may NOT contain; documentation is stripped.
    const metadataOwners = new Set([
      "packages/agent/src/tools/admission/gate-port.ts",
      "packages/agent/src/tools/admission/durable-metadata-port.ts",
      // A durable Tool event payload states the invocation's own `riskLevel`, which is the persisted
      // Protocol field rather than a Coding capability model.
      "packages/agent/src/tools/durable/durable-events.ts",
      // The durable coordinator validates the invocation row it is about to commit, including that
      // field. It never reads a capability.
      "packages/agent/src/tools/durable/durable-execution-coordinator.ts",
      "packages/agent/src/tools/durable/invocation-lifecycle.ts",
    ]);

    for (const file of await activeSourceFiles(["packages/agent/src/tools"])) {
      const text = code(await read(file));
      const codingVocabulary = [
        "FILE_READ",
        "FILE_CHANGE",
        "SHELL_STARTED",
        "SHELL_COMPLETED",
        "PROCESS_STARTED",
        "PROCESS_STOPPED",
        "changedFiles",
        "activeProcesses",
        "CodingToolDefinition",
        "CodingToolCatalog",
        "CodingToolSecurityMetadata",
        "promptSnippet",
        "securityFactsProjector",
        "effectProjector",
      ];
      for (const name of codingVocabulary) {
        expect(text, `${file} / ${name}`).not.toContain(name);
      }

      if (metadataOwners.has(file)) continue;
      expect(text, `${file} / riskLevel`).not.toContain("riskLevel");
      expect(text, `${file} / requiredCapabilities`).not.toContain("requiredCapabilities");
      expect(text, `${file} / runtimeRequirements`).not.toContain("runtimeRequirements");
    }
  });

  it("keeps real Tool execution sequential and the execution mode a declaration", async () => {
    const executionMode = code(await read("packages/agent/src/tools/types/execution-mode.ts"));
    expect(executionMode).toContain("PARALLEL_SAFE");
    expect(executionMode).toContain("DEFAULT_TOOL_EXECUTION_MODE");

    // No Tool execution path may fan out.
    for (const file of [
      "packages/agent/src/tools/batch/batch-coordinator.ts",
      "packages/agent/src/tools/durable/durable-execution-coordinator.ts",
      "packages/agent/src/tools/execution/invocation-executor.ts",
    ]) {
      const text = code(await read(file));
      expect(text, file).not.toContain("Promise.all");
      expect(text, file).not.toContain("Promise.allSettled");
    }
  });

  it("keeps a Tool from ending a Run", async () => {
    for (const file of await activeSourceFiles([
      "packages/agent/src/tools",
      "packages/coding-agent/src/tools",
    ])) {
      const text = code(await read(file));
      // A Tool may not decide a Run's terminal state, and it may not write one. `COMPLETED` / `FAILED`
      // / `CANCELLED` are legitimate *ToolInvocation* statuses — the ledger owns those — so the rule is
      // stated against `terminate` and against the Run/AgentState writers, not against the words.
      expect(text, file).not.toContain("terminate: true");
      expect(text, file).not.toContain("terminate:true");
      for (const runWriter of [
        "completeAgentRunWithFinalResult",
        "failAgentRun",
        "cancelAgentRun",
        "timeOutAgentRun",
        "RunStatus",
        "AgentStateStatus",
      ]) {
        expect(text, `${file} / ${runWriter}`).not.toContain(runWriter);
      }
    }
  });

  it("keeps the approval identity free of presentation fields", async () => {
    const identity = code(
      await read("packages/coding-agent/src/tools/security/approval-identity.ts"),
    );
    for (const presentation of ["action", "title", "safeAction", "presentation"]) {
      expect(identity, presentation).not.toMatch(new RegExp(`\\b${presentation}\\b\\s*:`));
    }
  });
});

describe("Phase 4F guard — the Phase 3 frozen contracts are unchanged", () => {
  it("keeps every frozen Phase 3 declaration in its frozen file", async () => {
    const frozen: readonly (readonly [string, string])[] = [
      ["packages/agent/src/run/ports/tool-turn.ts", "export interface ToolTurnCoordinator {"],
      ["packages/agent/src/run/ports/tool-turn.ts", "export interface ToolTurnRequest {"],
      ["packages/agent/src/run/ports/tool-turn.ts", "export type ToolTurnResult ="],
      ["packages/agent/src/run/ports/completion-gate.ts", "export interface CompletionGate {"],
      ["packages/agent/src/run/ports/completion-gate.ts", "export interface CompletionGateInput {"],
      ["packages/agent/src/run/ports/completion-gate.ts", "export type CompletionGateDecision ="],
      [
        "packages/agent/src/loop/turn/model-turn-executor.ts",
        "export interface ModelTurnExecutor {",
      ],
      [
        "packages/agent/src/run/run-execution-coordinator.ts",
        "export interface RunExecutionCoordinator {",
      ],
      ["packages/agent/src/run/run-execution-driver.ts", "export interface RunExecutionDriver {"],
      [
        "packages/agent/src/run/run-execution-driver.ts",
        "export interface RunExecutionDriverDependencies {",
      ],
      [
        "packages/agent/src/run/run-transition-planner.ts",
        "export interface RunTransitionPlanner {",
      ],
      ["packages/agent/src/run/effect-result.ts", "export type RunExecutionEffectResult ="],
      [
        "packages/agent/src/run/continuation/continuation.ts",
        "export type RunContinuationCheckpoint =",
      ],
    ];

    for (const [file, declaration] of frozen) {
      const text = code(await read(file));
      expect(text, `${file} / ${declaration}`).toContain(declaration);
    }
  });

  it("keeps AgentLoop and its advance result in @caelush/agent", async () => {
    const agentIndex = code(await read("packages/agent/src/index.ts"));
    expect(agentIndex).toContain("AgentLoopAdvanceResult");
    expect(agentIndex).toContain("RunExecutionDirective");
    expect(agentIndex).toContain("AgentLoop");

    // One declaration of the loop contract, and the Run Layer consumes it rather than redeclaring it.
    expect(await declarationHolders("export interface AgentLoop {")).toEqual([
      "packages/agent/src/loop/agent-loop.ts",
    ]);
  });

  it("keeps the frozen Run status machine single-owner", async () => {
    expect(await declarationHolders("export const RUN_STATUS_TRANSITIONS")).toEqual([
      "packages/agent/src/run/state/run-state-machine.ts",
    ]);
  });
});

describe("Phase 4F guard — production composition is the canonical one", () => {
  it("composes exactly the canonical Tool pipeline in the daemon", async () => {
    const source = code(await read("apps/daemon/src/daemon-composition.ts"));

    expect(source).toContain("createToolCallPreparer(");
    expect(source).toContain("createToolBatchCoordinator({");
    expect(source).toContain("createDurableToolExecutionCoordinator({");
    expect(source).toContain("createToolAdmissionCoordinator({");
    expect(source).toContain("createToolFailureSettlement({");
    expect(source).toContain("createModelToolFeedbackProjector({");
    expect(source).toContain("createToolResultBatchNormalizer()");
    expect(source).toContain("createToolInvocationExecutor({");
    expect(source).toContain("createToolResultPipeline({");
    expect(source).toContain("DefaultAgentToolRegistryBuilder");
    expect(source).toContain("CodingToolCatalogBuilder");
    expect(source).toContain("createCodingToolAdmissionPort({");
    expect(source).toContain("createCodingToolDurableMetadataPort({");
    expect(source).toContain("createCodingToolSettlementExtensionProjector({");
    expect(source).toContain("assertDefaultBuiltinSecurityCoverage(");
    expect(source).toContain("createDefaultCodingTools(");
    // The retired facade is neither constructed nor referenced as a value.
    expect(source).not.toMatch(/\bToolDispatcher\s*[;,)<]/);
    expect(source).not.toMatch(/\bToolBatchCoordinator\s*[;,)<]/);
  });

  it("keeps the daemon bootstrap free of any legacy Tool composition", async () => {
    const source = code(await read("apps/daemon/src/daemon.ts"));
    expect(source).toContain("createDefaultCodingTools(");
    expect(source).toContain("createCodingToolSettlementExtensionDecoder");
    for (const dead of [
      "createDefaultBuiltinToolRegistrations",
      "ToolRegistryBuilder",
      "createLegacyToolSettlementExtensionDecoder",
      "CAELUSH_DEBUG_TOOL_CALLING",
    ]) {
      expect(source, dead).not.toContain(dead);
    }
  });

  it("keeps the Coding settlement extension kind byte-identical", async () => {
    const effects = code(await read("packages/coding-agent/src/tools/effects/effects.ts"));
    expect(effects).toContain('CODING_TOOL_EFFECTS_PAYLOAD_KIND = "caelush.coding.effects.v1"');
    const agentPolicy = code(await read("packages/agent/src/tools/result/result-policy.ts"));
    expect(agentPolicy).toContain(
      'CODING_TOOL_EFFECTS_EXTENSION_KIND = "caelush.coding.effects.v1"',
    );
  });

  it("keeps the default Coding Tool order the single declaration of it", async () => {
    expect(await declarationHolders("DEFAULT_CODING_TOOL_ORDER = Object.freeze([")).toEqual([
      "packages/coding-agent/src/tools/builtins/default-tools.ts",
    ]);
  });

  it("has no empty-shell re-export package standing in for the retired one", async () => {
    // The anti-pattern Phase 4F refuses to leave behind is a *compatibility shell*: a workspace
    // package whose public surface is nothing but a namespace or cross-package re-export, so a caller
    // can keep importing a retired name from a retired place. An intra-package barrel is a legitimate
    // public-API boundary, and a reserved-but-empty package identity claims nothing.
    for (const group of ["packages", "apps"]) {
      for (const entry of await readdir(abs(group), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const index = `${group}/${entry.name}/src/index.ts`;
        if (!(await exists(index))) continue;
        const text = code(await read(index));

        expect(text, `${index} is a wildcard re-export shell`).not.toMatch(
          /^\s*export\s+\*\s+from\s+"(?:@caelush\/|\.\.\/)/m,
        );
        expect(text, `${index} re-exports another workspace package`).not.toMatch(
          /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+"@caelush\/[^"]+";\s*$/m,
        );

        const exports = [...text.matchAll(/^\s*export\b/gm)].length;
        if (exports === 0) continue;
        const crossPackage = [...text.matchAll(/^\s*export\b[^;]*from\s+"@caelush\//gm)].length;
        expect(
          crossPackage / exports,
          `${index} is mostly a cross-package pass-through`,
        ).toBeLessThan(1);
      }
    }
  });

  it("keeps the Runtime free of any Tool dependency", async () => {
    const runtime = JSON.parse(await read("packages/runtime/package.json")) as {
      dependencies?: Record<string, string>;
    };
    for (const name of [
      "@caelush/agent",
      "@caelush/coding-agent",
      "@caelush/core",
      "@caelush/storage",
      "@caelush/security",
      "@caelush/verification",
    ]) {
      expect(runtime.dependencies?.[name], name).toBeUndefined();
    }
  });

  it("keeps the retired package out of the workspace build graph", async () => {
    const workspaceFile = await read("pnpm-workspace.yaml");
    expect(workspaceFile).not.toContain("packages/tools");

    const lockfile = await read("pnpm-lock.yaml");
    expect(lockfile).not.toContain("packages/tools");

    const rootManifest = JSON.parse(await read("package.json")) as {
      devDependencies?: Record<string, string>;
    };
    expect(rootManifest.devDependencies?.["@caelush/tools"]).toBeUndefined();
  });

  it("keeps every tsconfig reference pointing at a package that exists", async () => {
    for (const group of ["packages", "apps"]) {
      for (const entry of await readdir(abs(group), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const tsconfig = `${group}/${entry.name}/tsconfig.json`;
        if (!(await exists(tsconfig))) continue;
        const parsed = JSON.parse(
          (await read(tsconfig)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
        ) as { references?: readonly { path: string }[] };
        for (const reference of parsed.references ?? []) {
          const resolved = path
            .resolve(abs(group, entry.name), reference.path)
            .replaceAll("\\", "/")
            .replace(`${repositoryRoot.replaceAll("\\", "/")}/`, "");
          expect(await exists(resolved), `${tsconfig} → ${reference.path}`).toBe(true);
        }
      }
    }
  });
});

describe("Phase 4F guard — source anchors", () => {
  it("reads a real file for every path this guard names", async () => {
    // A missing source file would make several assertions vacuously true. This pins the anchors.
    for (const anchor of [
      "packages/agent/src/tools/registry/registry.ts",
      "packages/agent/src/tools/batch/batch-coordinator.ts",
      "packages/agent/src/tools/durable/durable-execution-coordinator.ts",
      "packages/agent/src/tools/observation/model-feedback-projector.ts",
      "packages/coding-agent/src/tools/builtins/default-tools.ts",
      "packages/coding-agent/src/tools/settlement/settlement-extension.ts",
      "packages/coding-agent/src/tools/settlement/settlement-extension-projector.ts",
      "packages/security/src/tool-gate.ts",
      "packages/protocol/src/tool.ts",
      "apps/daemon/src/daemon-composition.ts",
    ]) {
      expect(await exists(anchor), anchor).toBe(true);
      expect((await sourceOrEmpty(anchor)).length, anchor).toBeGreaterThan(0);
    }
  });
});
