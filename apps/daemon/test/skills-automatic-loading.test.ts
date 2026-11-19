import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDescriptor, ModelDescriptorSourcePort } from "@caelush/ai";
import { createRunId } from "@caelush/protocol";
import { createControlHookId } from "@caelush/agent";
import { createDefaultCodingTools } from "@caelush/coding-agent";
import { createInjectedReplayKeyProvider, createReplayProtection } from "@caelush/security";
import { openToolStorage } from "../../../packages/storage/test/support/tool-settlement-decoder.js";
import { makeRun, makeSession } from "../../../packages/storage/test/support/fixtures.js";
import type { CaelushStorage } from "@caelush/storage";
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
const BODY = "PHASE05_FROZEN_FRONTEND_CORE_BODY: keep layout responsive and accessible.";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: DaemonComposition | undefined;
let provider: ControlledProvider | undefined;
let invalidateBundleAfterNextRead = false;
let frozenCorePath: string | undefined;

interface ControlledProvider extends ControllableProviderServer {
  setSkillId(skillId: string): void;
}

afterEach(async () => {
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  await provider?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  composition = undefined;
  storage = undefined;
  provider = undefined;
  invalidateBundleAfterNextRead = false;
  frozenCorePath = undefined;
  directory = undefined;
});

describe("automatic Skill loading through the Run Tool and Context paths", () => {
  it("searches, reads, settles a generic binding, then projects the frozen core into a later Step", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-phase05-auto-loading-"));
    const workspaceRoot = join(directory, "workspace");
    const userRoot = join(directory, "user-skills");
    const artifactRoot = join(directory, "skill-artifacts");
    await mkdir(join(workspaceRoot, ".agents", "skills"), { recursive: true });
    await mkdir(join(userRoot, "frontend-design", "references"), { recursive: true });
    await writeFile(
      join(userRoot, "frontend-design", "SKILL.md"),
      `---\nname: frontend-design\ndescription: Build responsive frontend pages and interfaces.\nmetadata:\n  searchTerms: "web design, responsive layout, 优化页面"\n---\n${BODY}`,
      "utf8",
    );
    await writeFile(
      join(userRoot, "frontend-design", "references", "layout.md"),
      "A supplemental layout reference.",
      "utf8",
    );

    storage = await openToolStorage({
      path: join(directory, "caelush.db"),
      replayProtection: createReplayProtection(
        createInjectedReplayKeyProvider("phase05-fixture-key", Buffer.alloc(32, 0x35)),
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
    const contextFailures: unknown[] = [];
    const toolFailures: unknown[] = [];
    let deletedFrozenCore = false;
    provider = await createProvider((skillId) => skillId);
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
          id: createControlHookId("phase05-feedback-marker-note"),
          priority: 10,
          criticality: "REQUIRED",
          timeoutMs: 200,
          hook: {
            async contribute(input) {
              feedbackInputs.push(input.builtInFeedback);
              if (input.toolName === "read_skill" && invalidateBundleAfterNextRead) {
                invalidateBundleAfterNextRead = false;
                if (frozenCorePath === undefined)
                  throw new Error("Frozen core path is unavailable.");
                await rm(frozenCorePath);
                deletedFrozenCore = true;
              }
              return input.toolName === "read_skill"
                ? [
                    {
                      id: "marker-note",
                      text: "Host processed the bounded read marker.",
                      placement: "APPEND",
                    },
                  ]
                : [];
            },
          },
        },
        {
          id: createControlHookId("phase05-feedback-optional-failure"),
          priority: 20,
          criticality: "OPTIONAL",
          timeoutMs: 200,
          hook: {
            async contribute(input) {
              if (input.toolName === "read_skill") throw new Error("feedback hook fixture failure");
              return [];
            },
          },
        },
      ],
      logger: {
        contextPreparationFailure(entry) {
          contextFailures.push(entry);
        },
        toolFailure(entry) {
          toolFailures.push(entry);
        },
      },
      configResolver: {
        resolve: async () => ({
          baseSystemPrompt: "Use the bounded Skill discovery Tools when relevant.",
          modelSettings: {
            maxOutputTokens: 2_048,
            temperature: 0,
          },
        }),
      },
    });

    const discovered = await skillProvider.discover({
      workspaceId: workspaceRef.id,
      signal: new AbortController().signal,
    });
    const skill = discovered.candidates.find(({ manifest }) => manifest.name === "frontend-design");
    if (skill === undefined) throw new Error("Fixture Skill was not discovered.");
    provider.setSkillId(skill.skillId);
    expect(composition.toolRegistry.names()).toHaveLength(16);
    expect(composition.skillFeatureReadiness).toMatchObject({
      enabled: true,
      invocationReady: true,
      scriptExecutionReady: false,
    });

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
      selections: [],
      model: { provider: "deepseek", model: MODEL_ID },
      signal: new AbortController().signal,
    });
    const frozenSnapshot = await composition.runSkillCatalogSnapshots!.readRunSkillCatalogSnapshot(
      prepared.workflowProfile.catalogSnapshotRef,
    );
    const frozenSkill = frozenSnapshot.skills.find(({ skillId }) => skillId === skill.skillId);
    if (frozenSkill === undefined) throw new Error("Skill was not included in the Run snapshot.");
    frozenCorePath = join(
      artifactRoot,
      "bundles",
      "bundles",
      frozenSkill.bundle.bundleRevision.slice("sha256:".length),
      "SKILL.md",
    );
    const runDraft = makeRun(session.id, {
      id: runId,
      goal: "Find the frontend guidance and use it for this response.",
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
      failures: contextFailures,
      toolFailures,
      stateErrors: (await storage.runStates.get(run.id))?.errors,
      invocationStates: (await storage.toolInvocations.listByRun(run.id)).map(
        ({ toolName, status }) => ({ toolName, status }),
      ),
      observationCount: (await storage.observations.listByRun(run.id)).length,
      providerRequests: provider.requests.length,
    });
    expect(result.run.status, diagnostic).toBe("COMPLETED");
    expect(contextFailures).toEqual([]);
    expect(toolFailures).toEqual([]);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0]?.body.messages).toBeDefined();
    const nextTurnInput = JSON.stringify(provider.requests[2]?.body.messages);
    expect(nextTurnInput).toContain(BODY);
    expect(nextTurnInput).toContain("Host processed the bounded read marker.");

    const invocations = await storage.toolInvocations.listByRun(run.id);
    const searchInvocation = invocations.find(({ toolName }) => toolName === "search_skills");
    const readInvocation = invocations.find(({ toolName }) => toolName === "read_skill");
    expect(searchInvocation?.status).toBe("COMPLETED");
    expect(readInvocation?.status).toBe("COMPLETED");
    const bindings = await storage.runs.readPreparedResources!(run.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      runId: run.id,
      resourceKind: "WORKFLOW_INSTRUCTION",
      resourceId: skill.skillId,
      sourceFingerprint: frozenSkill.bundle.manifestFingerprint,
      sourceToolInvocationId: readInvocation?.id,
    });
    expect(JSON.stringify(bindings)).not.toContain(BODY);
    expect(JSON.stringify(bindings)).not.toContain("projectionFingerprint");

    const receipts = await storage.runs.readPreparedInputReceipts!(run.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      runId: run.id,
      bindingId: bindings[0]?.bindingId,
      rendererVersion: prepared.workflowProfile.workflowRendererVersion,
    });
    const observations = await storage.observations.listByRun(run.id);
    expect(JSON.stringify(observations)).not.toContain(BODY);
    expect(feedbackInputs.join("\n")).toContain("Skill content is ready");
    expect(feedbackInputs.join("\n")).not.toContain(BODY);
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
    const serializedPublic = JSON.stringify({ transcript, publicEvents });
    expect(serializedPublic).not.toContain(BODY);
    expect(serializedPublic).not.toContain(bindings[0]?.artifactRef);
    expect(serializedPublic).not.toContain(workspaceRoot);

    const contextFailureRunId = createRunId();
    const contextFailureSession = makeSession({
      workspaceId: workspaceRef.id as never,
      defaultWorkspace: workspaceRef,
      defaultModel: { provider: "deepseek", model: MODEL_ID },
    });
    await storage.sessions.insert(contextFailureSession);
    const contextFailurePrepared = await composition.selectedSkillPreparer!.prepare({
      runId: contextFailureRunId,
      workspaceId: workspaceRef.id,
      selections: [],
      model: { provider: "deepseek", model: MODEL_ID },
      signal: new AbortController().signal,
    });
    const contextFailureDraft = makeRun(contextFailureSession.id, {
      id: contextFailureRunId,
      goal: "Load the Skill, then preserve its settled Tool fact if Context materialization fails.",
      workspace: workspaceRef,
      model: { provider: "deepseek", model: MODEL_ID },
      runtime: { id: "local", kind: "local" },
      permissionProfile: "READ_ONLY",
      approvalPolicy: "ON_BOUNDARY",
      completionContract: "NATURAL_V1",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 30_000 },
    });
    const contextFailureRun = {
      ...contextFailureDraft,
      contextBudgetPolicy:
        await composition.contextBudgetPolicyResolver.resolve(contextFailureDraft),
    };
    await storage.runs.insertRunWithPreparedResources!({
      run: contextFailureRun,
      workflowProfile: contextFailurePrepared.workflowProfile,
      resourcesInOrder: contextFailurePrepared.bindingsInSelectionOrder,
      events: [],
    });

    invalidateBundleAfterNextRead = true;
    const contextFailureResult = await composition.controller.start(contextFailureRun.id);
    expect(contextFailureResult.run.status).toBe("FAILED");
    expect(
      deletedFrozenCore,
      JSON.stringify({
        contextFailures,
        runErrors: (await storage.runStates.get(contextFailureRun.id))?.errors,
        runState: await storage.runStates.get(contextFailureRun.id),
        runRecord: await storage.runs.get(contextFailureRun.id),
        providerRequests: provider.requests.length,
        invocationStates: (await storage.toolInvocations.listByRun(contextFailureRun.id)).map(
          ({ toolName, status }) => ({ toolName, status }),
        ),
        observationCount: (await storage.observations.listByRun(contextFailureRun.id)).length,
      }),
    ).toBe(true);
    expect(contextFailures).toHaveLength(1);
    const contextFailureInvocations = await storage.toolInvocations.listByRun(contextFailureRun.id);
    expect(contextFailureInvocations.map(({ toolName, status }) => ({ toolName, status }))).toEqual(
      [{ toolName: "read_skill", status: "COMPLETED" }],
    );
    expect(provider.requests).toHaveLength(4);
    const failedRunBindings = await storage.runs.readPreparedResources!(contextFailureRun.id);
    expect(failedRunBindings).toHaveLength(1);
    expect(await storage.runs.readPreparedInputReceipts!(contextFailureRun.id)).toEqual([]);
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
    id: "phase05-controlled-provider",
    priority: 100,
    resolve: (ref) =>
      ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
        ? descriptor
        : undefined,
  };
}

async function createProvider(
  resolveSkillId: (skillId: string) => string,
): Promise<ControlledProvider> {
  let selectedSkillId = "";
  const turns = [
    {
      kind: "TOOL" as const,
      id: "phase05-search",
      toolName: "search_skills",
      args: { query: "优化页面", pageSize: 10 },
    },
    {
      kind: "TOOL" as const,
      id: "phase05-read",
      toolName: "read_skill",
      args: () => ({ skillId: resolveSkillId(selectedSkillId) }),
    },
    { kind: "ANSWER" as const, text: "I used the frozen frontend instructions for this response." },
    {
      kind: "TOOL" as const,
      id: "phase05-context-failure-read",
      toolName: "read_skill",
      args: () => ({ skillId: resolveSkillId(selectedSkillId) }),
    },
  ];
  const server = await createControllableProviderServer(async (request, response) => {
    if (!request.path.endsWith("/chat/completions") || request.method !== "POST") {
      throw new Error("The controlled Phase 05 Provider received an unexpected request.");
    }
    const turn = turns[request.index];
    if (turn === undefined)
      throw new Error("The controlled Phase 05 Provider script was exhausted.");
    beginOpenAISse(response);
    if (turn.kind === "TOOL") {
      const args = typeof turn.args === "function" ? turn.args() : turn.args;
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: { reasoning_content: `Controlled tool choice ${request.index}.` },
      });
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: turn.id,
              type: "function",
              function: { name: turn.toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
      });
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: {},
        finishReason: "tool_calls",
      });
    } else {
      writeOpenAIChunk(response, {
        model: MODEL_ID,
        delta: { reasoning_content: "Controlled answer reasoning.", content: turn.text },
        finishReason: "stop",
      });
    }
    response.end("data: [DONE]\n\n");
  });
  return {
    ...server,
    setSkillId(skillId: string) {
      selectedSkillId = skillId;
    },
  };
}
