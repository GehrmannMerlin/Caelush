import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import { createRunId } from "@caelush/protocol";
import { createControlHookId } from "@caelush/agent";
import { createDefaultCodingTools } from "@caelush/coding-agent";
import { createInjectedReplayKeyProvider, createReplayProtection } from "@caelush/security";
import { MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS } from "@caelush/agent";
import type { CaelushStorage } from "@caelush/storage";
import { openToolStorage } from "../../../packages/storage/test/support/tool-settlement-decoder.js";
import { makeRun, makeSession } from "../../../packages/storage/test/support/fixtures.js";
import { createFilesystemSkillBundleStore } from "../src/skills/bundle-store.js";
import { createSkillCatalogService } from "../src/skills/catalog-service.js";
import { createFilesystemSkillProvider } from "../src/skills/filesystem-provider.js";
import { createRunSkillCatalogSnapshotService } from "../src/skills/run-catalog-snapshot.js";
import { createRunSkillModelCatalogService } from "../src/skills/run-skill-search.js";
import { createRunSkillOperationsAdapter } from "../src/skills/skill-operations-adapter.js";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";
import { SessionTranscriptService } from "../src/services/session-transcript-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import {
  beginOpenAISse,
  createControllableProviderServer,
  writeOpenAIChunk,
} from "./support/controllable-provider-server.js";
import type { ControllableProviderServer } from "./support/controllable-provider-server.js";
import { afterEach, describe, expect, it } from "vitest";

const MODEL_ID = "deepseek-reasoner";
const RESERVED_BODY = "R".repeat(10_000);
const REJECTED_BODY = "F".repeat(40_000);
const FALLBACK_BODY = "Use the smaller layout guidance and keep controls keyboard accessible.";
const SAFE_REJECTION =
  "The Skill content could not be activated within the Run's content budget. Choose a smaller Skill or another approach.";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: DaemonComposition | undefined;
interface BudgetProvider extends ControllableProviderServer {
  setSkillIds(ids: { readonly rejected: string; readonly fallback: string }): void;
}

let provider: BudgetProvider | undefined;

afterEach(async () => {
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  await provider?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  composition = undefined;
  storage = undefined;
  provider = undefined;
  directory = undefined;
});

describe("automatic Skill binding budget through the real Run Tool batch", () => {
  it("settles a safe budget rejection once and lets the next Provider turn choose a smaller Skill", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-phase05-skill-budget-"));
    const workspaceRoot = join(directory, "workspace");
    const userRoot = join(directory, "user-skills");
    const artifactRoot = join(directory, "skill-artifacts");
    await mkdir(join(workspaceRoot, ".agents", "skills"), { recursive: true });
    await writeSkill(userRoot, "reserved-context", {
      description: "Long user-selected guidance that fills most of the Run Skill budget.",
      body: RESERVED_BODY,
      searchTerms: "selected context",
    });
    await writeSkill(userRoot, "frontend-design", {
      description: "Build polished responsive frontend pages and interfaces.",
      body: REJECTED_BODY,
      searchTerms: "web design, responsive layout, 优化页面",
    });
    await writeSkill(userRoot, "quick-layout", {
      description: "Compact fallback guidance for small responsive interface changes.",
      body: FALLBACK_BODY,
      searchTerms: "compact fallback",
    });

    storage = await openToolStorage({
      path: join(directory, "caelush.db"),
      replayProtection: createReplayProtection(
        createInjectedReplayKeyProvider("phase05-budget-fixture-key", Buffer.alloc(32, 0x46)),
      ),
    });
    const workspaceService = new WorkspaceService({ repository: storage.workspaces });
    const workspace = await workspaceService.registerWorkspace({ path: workspaceRoot });
    const workspaceRef = {
      id: workspace.workspace.id,
      path: workspace.workspace.canonicalPath,
    };
    const skillProvider = createFilesystemSkillProvider({
      userRoot,
      resolveWorkspaceRoot: async () => workspaceRoot,
    });
    const catalog = createSkillCatalogService({
      provider: skillProvider,
      settings: storage.skillSettings,
      selectionTokenSecret: Buffer.alloc(32, 0x47),
    });
    const resolveBundleSource = async (
      skillId: string,
      workspaceId?: string,
      candidateOverride?: import("@caelush/skills").SkillCandidate,
    ) => {
      if (workspaceId === undefined) return null;
      const candidate =
        candidateOverride ??
        (
          await skillProvider.discover({ workspaceId, signal: new AbortController().signal })
        ).candidates.find((entry) => entry.skillId === skillId);
      if (candidate === undefined || candidate.skillId !== skillId) return null;
      const locator = await skillProvider.resolveLocator(candidate.privateLocator, workspaceId);
      if (locator === null) return null;
      return {
        candidate,
        scopeId: candidate.providerId,
        rootDirectory: locator.rootDirectory,
        packageDirectory: locator.packageDirectory,
      };
    };
    const bundles = createFilesystemSkillBundleStore({
      rootDirectory: join(artifactRoot, "bundles"),
      resolveSource: resolveBundleSource,
    });
    const snapshots = createRunSkillCatalogSnapshotService({
      rootDirectory: join(artifactRoot, "run-catalogs"),
      catalog,
      bundleStore: bundles,
    });
    const modelCatalog = createRunSkillModelCatalogService({
      runs: storage.runs,
      snapshots,
    });
    const skillOperations = createRunSkillOperationsAdapter({
      runs: storage.runs,
      snapshots,
      bundles,
      modelCatalog,
    });
    const toolRegistrations = createDefaultCodingTools({
      readFile: {} as never,
      readOnly: {} as never,
      patch: {} as never,
      exec: {} as never,
      process: {} as never,
      git: {} as never,
      skills: skillOperations,
    });
    const feedbackInputs: string[] = [];
    const toolFailures: unknown[] = [];
    const contextFailures: unknown[] = [];
    provider = await createBudgetProvider();
    composition = await composeDaemon({
      storage,
      skillProvider,
      skillArtifactRoot: artifactRoot,
      skillFeatureEnabled: true,
      toolRegistrations,
      providers: [
        {
          provider: "deepseek",
          baseUrl: provider.endpoint,
          apiKey: "fixture-only",
          allowedModels: [MODEL_ID],
        },
      ],
      modelSources: [deepSeekModelSource()],
      defaultModel: { provider: "deepseek", model: MODEL_ID },
      toolExposure: "AVAILABLE",
      toolFeedbackContributionHooks: [
        {
          id: createControlHookId("phase05-budget-feedback"),
          priority: 10,
          criticality: "REQUIRED",
          timeoutMs: 200,
          hook: {
            async contribute(input) {
              feedbackInputs.push(input.builtInFeedback);
              return input.toolName === "read_skill"
                ? [
                    {
                      id: "bounded-feedback-note",
                      text: "Only the bounded result marker was reviewed.",
                      placement: "APPEND",
                    },
                  ]
                : [];
            },
          },
        },
      ],
      logger: {
        toolFailure(entry) {
          toolFailures.push(entry);
        },
        contextPreparationFailure(entry) {
          contextFailures.push(entry);
        },
      },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt:
            "Use search and reading Tools when relevant, and adapt after a safe budget failure.",
          modelSettings: { maxOutputTokens: 2_048, temperature: 0 },
        }),
      },
    });

    const discovered = await skillProvider.discover({
      workspaceId: workspaceRef.id,
      signal: new AbortController().signal,
    });
    const byName = new Map(
      discovered.candidates.map((candidate) => [candidate.manifest.name, candidate]),
    );
    const reservedSkill = byName.get("reserved-context");
    const rejectedSkill = byName.get("frontend-design");
    const fallbackSkill = byName.get("quick-layout");
    if (reservedSkill === undefined || rejectedSkill === undefined || fallbackSkill === undefined) {
      throw new Error("The budget fixture Skills were not discovered.");
    }
    provider.setSkillIds({ rejected: rejectedSkill.skillId, fallback: fallbackSkill.skillId });
    const userPage = await composition.skillCatalog!.listUserCatalog({
      workspaceId: workspaceRef.id,
      pageSize: 100,
      signal: new AbortController().signal,
    });
    const reservedSelection = userPage.items.find(({ name }) => name === "reserved-context");
    if (reservedSelection === undefined)
      throw new Error("The selected reserve Skill has no token.");

    const session = makeSession({
      workspaceId: workspaceRef.id as never,
      defaultWorkspace: workspaceRef,
      defaultModel: { provider: "deepseek", model: MODEL_ID },
    });
    await storage.sessions.insert(session);
    const runId = createRunId();
    const prepared = await composition.selectedSkillPreparer!.prepare({
      runId,
      workspaceId: workspaceRef.id,
      selections: [
        { skillId: reservedSelection.skillId, selectionToken: reservedSelection.selectionToken },
      ],
      model: { provider: "deepseek", model: MODEL_ID },
      signal: new AbortController().signal,
    });
    const frozenSnapshot = await composition.runSkillCatalogSnapshots!.readRunSkillCatalogSnapshot(
      prepared.workflowProfile.catalogSnapshotRef,
    );
    const reservedFrozen = frozenSnapshot.skills.find(
      ({ skillId }) => skillId === reservedSkill.skillId,
    );
    const rejectedFrozen = frozenSnapshot.skills.find(
      ({ skillId }) => skillId === rejectedSkill.skillId,
    );
    const fallbackFrozen = frozenSnapshot.skills.find(
      ({ skillId }) => skillId === fallbackSkill.skillId,
    );
    if (
      reservedFrozen === undefined ||
      rejectedFrozen === undefined ||
      fallbackFrozen === undefined
    ) {
      throw new Error("The frozen catalog omitted a budget fixture Skill.");
    }
    const reservedTokens = prepared.bindingsInSelectionOrder[0]?.tokenEstimate;
    if (reservedTokens === undefined)
      throw new Error("The reserve Skill binding was not prepared.");
    expect(reservedTokens).toBeGreaterThan(MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS * 0.2);
    expect(reservedTokens).toBeLessThan(MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS * 0.3);
    expect(
      reservedTokens + Math.ceil(Buffer.byteLength(REJECTED_BODY, "utf8") / 3),
    ).toBeGreaterThan(MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS);

    const runDraft = makeRun(session.id, {
      id: runId,
      goal: "Find frontend guidance and use an alternative if its core exceeds the Run budget.",
      workspace: workspaceRef,
      model: { provider: "deepseek", model: MODEL_ID },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ON_BOUNDARY",
      completionContract: "NATURAL_V1",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 30_000 },
    });
    const run = {
      ...runDraft,
      contextBudgetPolicy: await composition.contextBudgetPolicyResolver.resolve(runDraft),
    };
    await storage.runs.insertRunWithPreparedResources!({
      run,
      workflowProfile: prepared.workflowProfile,
      resourcesInOrder: prepared.bindingsInSelectionOrder,
      events: [],
    });

    const result = await composition.controller.start(run.id);
    const diagnostic = JSON.stringify({
      toolFailures,
      contextFailures,
      stateErrors: (await storage.runStates.get(run.id))?.errors,
      invocations: (await storage.toolInvocations.listByRun(run.id)).map(
        ({ toolName, status }) => ({ toolName, status }),
      ),
      providerRequests: provider.requests.length,
    });
    expect(result.run.status, diagnostic).toBe("COMPLETED");
    expect(toolFailures).toEqual([]);
    expect(contextFailures).toEqual([]);
    expect(provider.requests).toHaveLength(5);
    const recoveryTurn = JSON.stringify(provider.requests[2]?.body.messages);
    expect(recoveryTurn).toContain(SAFE_REJECTION);
    expect(recoveryTurn).toContain("Only the bounded result marker was reviewed.");
    expect(recoveryTurn).not.toContain(REJECTED_BODY);
    const finalTurn = JSON.stringify(provider.requests[4]?.body.messages);
    expect(finalTurn).toContain(RESERVED_BODY);
    expect(finalTurn).toContain(FALLBACK_BODY);
    expect(finalTurn).not.toContain(REJECTED_BODY);

    const fallbackBatchMessages = provider.requests[3]?.body.messages as readonly {
      readonly role?: unknown;
      readonly tool_call_id?: unknown;
    }[];
    const fallbackToolResults = fallbackBatchMessages
      .filter(
        ({ role, tool_call_id }) =>
          role === "tool" &&
          ["phase05-budget-fallback-search", "phase05-budget-empty-search"].includes(
            String(tool_call_id),
          ),
      )
      .map(({ tool_call_id }) => tool_call_id);
    expect(fallbackToolResults).toEqual([
      "phase05-budget-fallback-search",
      "phase05-budget-empty-search",
    ]);
    expect(
      fallbackToolResults.filter((id) => id === "phase05-budget-fallback-search"),
    ).toHaveLength(1);
    expect(fallbackToolResults.filter((id) => id === "phase05-budget-empty-search")).toHaveLength(
      1,
    );

    const invocations = await storage.toolInvocations.listByRun(run.id);
    expect(invocations.map(({ toolName }) => toolName)).toEqual([
      "search_skills",
      "read_skill",
      "search_skills",
      "search_skills",
      "read_skill",
    ]);
    const failedRead = invocations.find(
      ({ toolName, args }) => toolName === "read_skill" && args.skillId === rejectedSkill.skillId,
    );
    const fallbackRead = invocations.find(
      ({ toolName, args }) => toolName === "read_skill" && args.skillId === fallbackSkill.skillId,
    );
    expect(failedRead?.status).toBe("FAILED");
    expect(fallbackRead?.status).toBe("COMPLETED");
    const failedSnapshot = await storage.toolExecution.load(failedRead!.id);
    expect(failedSnapshot?.observation?.isError).toBe(true);
    expect(failedSnapshot?.observation?.content).toContain(SAFE_REJECTION);
    expect(failedSnapshot?.observation?.content).not.toContain("bounded-feedback-note");
    expect(JSON.stringify(failedSnapshot?.observation)).not.toContain(REJECTED_BODY);
    expect(feedbackInputs).toContain(SAFE_REJECTION);
    expect(feedbackInputs.join("\n")).not.toContain(REJECTED_BODY);
    expect(feedbackInputs.join("\n")).not.toContain(RESERVED_BODY);

    const bindings = await storage.runs.readPreparedResources!(run.id);
    expect(bindings.map(({ resourceId }) => resourceId)).toEqual([
      reservedSkill.skillId,
      fallbackSkill.skillId,
    ]);
    expect(bindings.every(({ resourceId }) => resourceId !== rejectedSkill.skillId)).toBe(true);
    expect(
      bindings.reduce((total, binding) => total + binding.tokenEstimate, 0),
    ).toBeLessThanOrEqual(MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS);
    expect(bindings.filter(({ resourceId }) => resourceId === fallbackSkill.skillId)).toHaveLength(
      1,
    );
    const receipts = await storage.runs.readPreparedInputReceipts!(run.id);
    expect(receipts.some(({ bindingId }) => bindingId === bindings[1]?.bindingId)).toBe(true);
    expect(receipts.every(({ bindingId }) => bindingId !== undefined)).toBe(true);

    const transcriptService = new SessionTranscriptService({
      sessions: storage.sessions,
      runs: storage.runs,
      messageRecords: storage.messageRecords,
      codecs: composition.messages.codecs,
      transcriptProjectors: composition.transcriptProjectors,
    });
    const transcript = await transcriptService.getTranscript(session.id, { limit: 100 });
    const publicEvents = await storage.eventReader.replay(run.id, {
      afterSequence: 0,
      throughSequence: Number.MAX_SAFE_INTEGER,
      limit: 1_000,
    });
    const publicProjection = JSON.stringify({ transcript, publicEvents });
    expect(publicProjection).not.toContain(RESERVED_BODY);
    expect(publicProjection).not.toContain(REJECTED_BODY);
    expect(publicProjection).not.toContain(FALLBACK_BODY);
    expect(publicProjection).not.toContain(bindings[0]?.artifactRef);
    expect(publicProjection).not.toContain(bindings[1]?.artifactRef);
    expect(publicProjection).not.toContain(workspaceRoot);
  }, 60_000);
});

function deepSeekModelSource(): ModelDescriptorSourcePort {
  const descriptor: ModelDescriptor = {
    ref: { provider: "deepseek", model: MODEL_ID },
    api: "openai-compatible-chat",
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 2_048 },
    capabilities: {
      streaming: "SUPPORTED",
      toolCalling: "SUPPORTED",
      parallelToolCalls: "SUPPORTED",
      structuredOutput: "UNKNOWN",
      vision: "UNSUPPORTED",
      reasoning: "SUPPORTED",
      reasoningSummary: "UNKNOWN",
      promptCaching: "SUPPORTED",
      usageReporting: "SUPPORTED",
    },
    reasoning: { supportedLevels: ["HIGH"], supportsSummary: "UNKNOWN" },
    cache: { supportedRetentions: ["SHORT", "LONG"], defaultRetention: "LONG" },
    source: "CONFIGURATION",
    adapterMetadata: {
      "openai-compatible": {
        cacheDialect: "AUTOMATIC",
        requiresReasoningReplayWithTools: true,
      },
    },
  };
  return {
    id: "phase05-budget-controlled-provider",
    priority: 100,
    resolve: (ref) =>
      ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
        ? descriptor
        : undefined,
  };
}

async function createBudgetProvider(): Promise<BudgetProvider> {
  let skillIds = { rejected: "", fallback: "" };
  const turns = [
    {
      kind: "TOOL" as const,
      id: "phase05-budget-search",
      name: "search_skills",
      args: { query: "优化页面", pageSize: 10 },
    },
    { kind: "TOOL" as const, id: "phase05-budget-rejected-read", name: "read_skill", args: {} },
    {
      kind: "BATCH" as const,
      calls: [
        {
          id: "phase05-budget-fallback-search",
          name: "search_skills",
          args: { query: "compact fallback", pageSize: 10 },
        },
        {
          id: "phase05-budget-empty-search",
          name: "search_skills",
          args: { query: "no matching alternative", pageSize: 10 },
        },
      ],
    },
    { kind: "TOOL" as const, id: "phase05-budget-fallback-read", name: "read_skill", args: {} },
    {
      kind: "ANSWER" as const,
      text: "I used the small fallback instructions after the first Skill exceeded the budget.",
    },
  ];
  const server = await createControllableProviderServer(
    async (request, response: ServerResponse) => {
      if (!request.path.endsWith("/chat/completions") || request.method !== "POST") {
        throw new Error("The controlled Phase 05 budget Provider received an unexpected request.");
      }
      const turn = turns[request.index];
      if (turn === undefined)
        throw new Error("The controlled Phase 05 budget Provider script was exhausted.");
      beginOpenAISse(response);
      if (turn.kind === "TOOL" || turn.kind === "BATCH") {
        const calls = turn.kind === "BATCH" ? turn.calls : [turn];
        const toolCalls = calls.map((call, index) => {
          const args =
            request.index === 1
              ? { skillId: skillIds.rejected }
              : request.index === 3
                ? { skillId: skillIds.fallback }
                : call.args;
          return {
            index,
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(args) },
          };
        });
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: { reasoning_content: `Controlled budget fallback choice ${request.index}.` },
        });
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: {
            tool_calls: toolCalls,
          },
        });
        writeOpenAIChunk(response, { model: MODEL_ID, delta: {}, finishReason: "tool_calls" });
      } else {
        writeOpenAIChunk(response, {
          model: MODEL_ID,
          delta: { reasoning_content: "Controlled answer reasoning.", content: turn.text },
          finishReason: "stop",
        });
      }
      response.end("data: [DONE]\n\n");
    },
  );
  return {
    ...server,
    setSkillIds(ids) {
      skillIds = { ...ids };
    },
  };
}

async function writeSkill(
  rootDirectory: string,
  folder: string,
  input: { readonly description: string; readonly body: string; readonly searchTerms: string },
): Promise<void> {
  const skillDirectory = join(rootDirectory, folder);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${folder}\ndescription: ${input.description}\nmetadata:\n  searchTerms: "${input.searchTerms}"\n---\n${input.body}`,
    "utf8",
  );
}
