import {
  createEventId,
  createRunId,
  createSessionId,
  createStepId,
  createWorkspaceId,
  type PublicRunEvent,
  type ClientAgentRun,
  type ClientAgentSession,
  type ContextUsageProjection,
  type DaemonInfo,
  type DefaultRunConfiguration,
  type HealthResponse,
  type RunListResponse,
  type SecurityCapabilitiesResponse,
  type SessionListResponse,
  type WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { CaelushClientProtocolError } from "@caelush/client";
import {
  CliConversationController,
  type CliDaemonClient,
} from "../src/application/cli-controller.js";

const defaultRunConfiguration: DefaultRunConfiguration = {
  runtime: { id: "local", kind: "local" },
  permissionProfile: "PROJECT_ACCESS",
  approvalPolicy: "DANGEROUS_ONLY",
  limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
};

describe("CliConversationController", () => {
  it("resolves repeated manual Skill names through the daemon and submits the selection receipt", async () => {
    const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
    const session = { ...makeSession(), defaultWorkspace: workspace };
    const selected = {
      skillId: "project:review-notes",
      name: "review-notes",
      description: "Review notes manually.",
      selectionToken: "opaque-selection-token",
      enabled: true,
      userInvocable: true,
      modelInvocable: false,
    };
    const secondSelected = {
      ...selected,
      skillId: "user:release-checklist",
      name: "release-checklist",
      selectionToken: "another-opaque-selection-token",
    };
    let createRunInput: Parameters<CliDaemonClient["createRun"]>[1] | undefined;
    const receiptReads: string[] = [];
    const client = makeClient({
      getSkillCapabilities: async () => ({
        schemaVersion: 1,
        enabled: true,
        catalog: true,
        invocation: true,
        scriptExecution: false,
        presentationVersion: 4,
      }),
      listSkills: async (workspaceId, query) => {
        expect(workspaceId).toBe(workspace.id);
        return {
          schemaVersion: 1,
          catalogRevision: "revision-1",
          items:
            query.q === selected.name
              ? [selected]
              : query.q === secondSelected.name
                ? [secondSelected]
                : [],
          complete: true,
          diagnostics: [],
        };
      },
      getSession: async () => session,
      getSessionTranscript: async () => ({ items: [] }),
      listRuns: async (): Promise<RunListResponse> => ({ items: [] }),
      createRun: async (_sessionId, input) => {
        createRunInput = input;
        return makeRun(input.goal);
      },
      getSubmissionSkillPreparation: async (_sessionId, runId) => {
        receiptReads.push(runId);
        return {
          schemaVersion: 1,
          runId,
          userText: "review the changes",
          preparationStatus: "CONTENT_READY",
          selectedSkills: [
            { skillId: selected.skillId, name: selected.name },
            { skillId: secondSelected.skillId, name: secondSelected.name },
          ],
        };
      },
      startRun: async () => actionResponse(makeRun("review the changes")),
    });
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      launchIntent: {
        kind: "RESUME_EXACT",
        sessionId: session.id,
        skillNames: ["review-notes", "release-checklist"],
      },
    });

    await controller.bootstrap();
    await controller.submitPrompt("review the changes");

    expect(createRunInput).toMatchObject({
      submissionId: expect.any(String),
      skillSelections: [
        { skillId: selected.skillId, selectionToken: selected.selectionToken },
        { skillId: secondSelected.skillId, selectionToken: secondSelected.selectionToken },
      ],
    });
    expect(receiptReads).toHaveLength(1);
    expect(controller.getState().skillPreparation).toMatchObject({
      preparationStatus: "CONTENT_READY",
      selectedSkills: [{ name: "review-notes" }, { name: "release-checklist" }],
    });
    controller.dispose();
  });

  it("continues resolving an exact manual Skill name on a later catalog page", async () => {
    const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
    const session = { ...makeSession(), defaultWorkspace: workspace };
    const exact = {
      skillId: "project:target-skill",
      name: "target-skill",
      description: "Exact match on page two.",
      selectionToken: "fresh-token",
      enabled: true,
      userInvocable: true,
      modelInvocable: false,
    };
    const decoys = Array.from({ length: 100 }, (_, index) => ({
      ...exact,
      skillId: `project:decoy-${String(index)}`,
      name: `decoy-${String(index)}`,
      description: "target-skill appears only in the description",
    }));
    const cursors: (string | undefined)[] = [];
    let createRunInput: Parameters<CliDaemonClient["createRun"]>[1] | undefined;
    const controller = new CliConversationController({
      client: makeClient({
        getSkillCapabilities: async () => ({
          schemaVersion: 1,
          enabled: true,
          catalog: true,
          invocation: true,
          scriptExecution: false,
          presentationVersion: 4,
        }),
        listSkills: async (_workspaceId, query) => {
          cursors.push(query.cursor);
          return query.cursor === undefined
            ? {
                schemaVersion: 1,
                catalogRevision: "revision-1",
                items: decoys,
                complete: false,
                nextCursor: "page-two",
              }
            : {
                schemaVersion: 1,
                catalogRevision: "revision-1",
                items: [exact],
                complete: true,
                diagnostics: [],
              };
        },
        getSession: async () => session,
        getSessionTranscript: async () => ({ items: [] }),
        listRuns: async (): Promise<RunListResponse> => ({ items: [] }),
        createRun: async (_sessionId, input) => {
          createRunInput = input;
          return makeRun(input.goal);
        },
        getSubmissionSkillPreparation: async (_sessionId, runId) => ({
          schemaVersion: 1,
          runId,
          userText: "Use the later result",
          preparationStatus: "CONTENT_READY",
          selectedSkills: [{ skillId: exact.skillId as never, name: exact.name }],
        }),
      }),
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: session.id, skillNames: [exact.name] },
    });

    await controller.bootstrap();
    await controller.submitPrompt("Use the later result");

    expect(cursors).toEqual([undefined, "page-two"]);
    expect(createRunInput?.skillSelections).toEqual([
      { skillId: exact.skillId, selectionToken: exact.selectionToken },
    ]);
    controller.dispose();
  });

  it("retains and starts the created Run when its follow-up Skill receipt read fails", async () => {
    const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
    const session = { ...makeSession(), defaultWorkspace: workspace };
    const createdRun = makeRun("Use this Skill");
    const createRun = vi.fn<CliDaemonClient["createRun"]>(async () => createdRun);
    const startRun = vi.fn<CliDaemonClient["startRun"]>(async () => actionResponse(createdRun));
    const controller = new CliConversationController({
      client: makeClient({
        getSkillCapabilities: async () => ({
          schemaVersion: 1,
          enabled: true,
          catalog: true,
          invocation: true,
          scriptExecution: false,
          presentationVersion: 4,
        }),
        listSkills: async () => ({
          schemaVersion: 1,
          catalogRevision: "revision-1",
          items: [
            {
              skillId: "project:review-notes",
              name: "review-notes",
              description: "Review notes manually.",
              selectionToken: "opaque-token",
              enabled: true,
              userInvocable: true,
              modelInvocable: false,
            },
          ],
          complete: true,
          diagnostics: [],
        }),
        getSession: async () => session,
        getSessionTranscript: async () => ({ items: [] }),
        listRuns: async (): Promise<RunListResponse> => ({ items: [] }),
        createRun,
        getSubmissionSkillPreparation: async () => {
          throw new Error("transient read failure");
        },
        startRun,
      }),
      workspacePath: workspace.path,
      launchIntent: {
        kind: "RESUME_EXACT",
        sessionId: session.id,
        skillNames: ["review-notes"],
      },
    });

    await controller.bootstrap();
    await controller.submitPrompt("Use this Skill");
    await controller.submitPrompt("Do not create another Run");

    expect(createRun).toHaveBeenCalledOnce();
    expect(startRun).toHaveBeenCalledWith(createdRun.id);
    expect(controller.getState().activeRun?.runId).toBe(createdRun.id);
    expect(controller.getState().composerEnabled).toBe(false);
    expect(controller.getState().skillPreparationWarning).toContain("暂时无法读取");
    controller.dispose();
  });

  it("rejects an unknown or non-invocable Skill name before creating a Run", async () => {
    const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
    const session = { ...makeSession(), defaultWorkspace: workspace };
    const createRun = vi.fn<CliDaemonClient["createRun"]>(async (_sessionId, input) =>
      makeRun(input.goal),
    );
    const controller = new CliConversationController({
      client: makeClient({
        getSkillCapabilities: async () => ({
          schemaVersion: 1,
          enabled: true,
          catalog: true,
          invocation: true,
          scriptExecution: false,
          presentationVersion: 4,
        }),
        listSkills: async () => ({
          schemaVersion: 1,
          catalogRevision: "revision-1",
          items: [],
          complete: true,
          diagnostics: [],
        }),
        getSession: async () => session,
        getSessionTranscript: async () => ({ items: [] }),
        listRuns: async (): Promise<RunListResponse> => ({ items: [] }),
        createRun,
      }),
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: session.id, skillNames: ["missing-skill"] },
    });

    await controller.bootstrap();

    expect(controller.getState().fatalError).toContain("missing-skill");
    expect(createRun).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("fails with an explicit compatibility error instead of ignoring --skill on an old daemon", async () => {
    const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
    const session = { ...makeSession(), defaultWorkspace: workspace };
    const controller = new CliConversationController({
      client: makeClient({
        getSkillCapabilities: async () => null,
        getSession: async () => session,
        getSessionTranscript: async () => ({ items: [] }),
        listRuns: async (): Promise<RunListResponse> => ({ items: [] }),
      }),
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: session.id, skillNames: ["review-notes"] },
    });

    await controller.bootstrap();

    expect(controller.getState().bootstrap).toBe("BOOTSTRAP_ERROR");
    expect(controller.getState().fatalError).toMatch(/daemon 不支持 --skill/u);
    controller.dispose();
  });

  it("uses --continue to select a current-workspace Session without creating one", async () => {
    const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
    const session = { ...makeSession(), defaultWorkspace: workspace };
    const client = makeClient({
      listSessions: async (): Promise<SessionListResponse> => ({ items: [session] }),
      listRuns: async (): Promise<RunListResponse> => ({ items: [] }),
    });
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      launchIntent: { kind: "CONTINUE" },
    });

    await controller.bootstrap();

    expect(controller.getState().session).toEqual(session);
    expect(controller.getState().workspace).toEqual(workspace);
    expect(controller.getState().composerEnabled).toBe(true);
    expect(controller.getState().controlMode).toBe("NONE");
    controller.dispose();
  });

  it("resumes the exact WorkspaceRef and uses current daemon defaults for a new Run", async () => {
    const workspace = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
    const session = { ...makeSession(), defaultWorkspace: workspace };
    let createRunInput: Parameters<CliDaemonClient["createRun"]>[1] | undefined;
    const client = makeClient({
      getSession: async () => session,
      getSessionTranscript: async () => ({ items: [] }),
      listRuns: async (): Promise<RunListResponse> => ({ items: [] }),
      createRun: async (_sessionId, input) => {
        createRunInput = input;
        return makeRun(input.goal);
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: workspace.path,
      launchIntent: { kind: "RESUME_EXACT", sessionId: session.id },
    });

    await controller.bootstrap();
    await controller.submitPrompt("new turn");

    expect(createRunInput).toMatchObject({
      workspace,
      model: session.defaultModel ?? makeInfo().defaultModel,
      runtime: defaultRunConfiguration.runtime,
      preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
      limits: defaultRunConfiguration.limits,
    });
    controller.dispose();
  });

  it("bootstraps health, compatibility, and one Session for the current workspace", async () => {
    const calls: string[] = [];
    const session = makeSession();
    const info = makeInfo();
    const client: CliDaemonClient = {
      getHealth: async () => {
        calls.push("health");
        return makeHealth();
      },
      getInfo: async () => {
        calls.push("info");
        return info;
      },
      createSession: async (input) => {
        calls.push("createSession");
        expect(input).toEqual({
          title: "project",
          defaultWorkspace: { id: expect.any(String), path: "C:\\workspace\\project" },
          defaultModel: { provider: "fixture", model: "fixture-model" },
          metadata: {},
        });
        return session;
      },
      createRun: async () => {
        throw new Error("not used");
      },
      watchRunEvents: async function* () {
        throw new Error("not used");
        yield* [] as PublicRunEvent[];
      },
      startRun: async () => {
        throw new Error("not used");
      },
      getRun: async () => {
        throw new Error("not used");
      },
      listSessions: async () => ({ items: [] }),
      getSession: async () => session,
      getSessionTranscript: async () => ({ items: [] }),
      listRuns: async () => ({ items: [] }),
      recoverRun: async () => actionResponse(makeRun("recovery")),
      cancelRun: async () => actionResponse(makeRun("cancel")),
      listPendingApprovals: async () => ({ items: [] }),
      resolveApproval: async () => actionResponse(makeRun("approval")),
    };
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });

    await controller.bootstrap();

    expect(calls).toEqual(["health", "info", "createSession"]);
    expect(controller.getState()).toMatchObject({
      bootstrap: "READY",
      session,
      composerEnabled: true,
      activity: "Ready",
    });
  });

  it("uses the canonical WorkspaceRef returned by Session creation for capability checks", async () => {
    const canonicalWorkspace = {
      id: createWorkspaceId(),
      path: "C:\\workspace\\canonical-project",
    };
    const session = { ...makeSession(), defaultWorkspace: canonicalWorkspace };
    const capabilities = {
      schemaVersion: 1,
      defaultPreset: "WORKSPACE_WRITE",
      presets: [
        {
          id: "WORKSPACE_WRITE",
          version: 1,
          displayName: "Workspace write",
          description: "Modify files in the workspace.",
          permissionProfile: "PROJECT_ACCESS",
          approvalPolicy: "ON_BOUNDARY",
          filesystemBoundary: "WORKSPACE_READ_WRITE",
          processBoundary: "WORKSPACE_WRITE",
          requiredEnforcement: "OS_RESTRICTED",
          requiresConfirmation: false,
        },
      ],
      processSandbox: { status: "AVAILABLE", enforcement: "HARD", provider: "fixture" },
      ttySupported: false,
      workspacePreparationSupported: false,
    } satisfies SecurityCapabilitiesResponse;
    const client = makeClient({
      createSession: async () => session,
      getSecurityCapabilities: async () => capabilities,
      getWorkspaceSecurityCapabilities: async (workspaceId) => {
        expect(workspaceId).toBe(canonicalWorkspace.id);
        return {
          schemaVersion: 1,
          workspaceId: canonicalWorkspace.id,
          presets: [{ id: "WORKSPACE_WRITE", version: 1, status: "AVAILABLE" }],
          preparation: { supported: false, status: "NOT_REQUIRED" },
        } satisfies WorkspaceSecurityCapabilitiesResponse;
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });

    await controller.bootstrap();

    expect(controller.getState().bootstrap).toBe("READY");
    expect(controller.getState().workspace).toEqual(canonicalWorkspace);
    controller.dispose();
  });

  it("creates one guarded Run and starts the watch before startRun", async () => {
    const calls: string[] = [];
    const run = makeRun("the first prompt");
    const client = makeClient({
      calls,
      createRun: async (_sessionId, input) => {
        calls.push("createRun");
        expect(input).toMatchObject({
          goal: "the first prompt",
          workspace: { path: "C:\\workspace\\project" },
          model: { provider: "fixture", model: "fixture-model" },
          runtime: defaultRunConfiguration.runtime,
          preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
          limits: defaultRunConfiguration.limits,
        });
        return run;
      },
      watchRunEvents: async function* () {
        calls.push("watch");
        await new Promise<void>(() => undefined);
        yield* [] as PublicRunEvent[];
      },
      startRun: async () => {
        calls.push("startRun");
        return actionResponse(run);
      },
    });
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();

    const first = controller.submitPrompt(" the first prompt ");
    const second = controller.submitPrompt("the second prompt");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);

    expect(calls).toEqual(["createRun", "watch", "startRun"]);
    expect(controller.getState().displayHistory).toEqual([
      {
        id: "user-1",
        conversationTurnId: run.id,
        createdAt: run.createdAt,
        kind: "USER",
        text: "the first prompt",
        runId: run.id,
      },
    ]);
    expect(controller.getState().composerEnabled).toBe(false);
    controller.dispose();
  });

  it("prints Cache Metrics V2 rates, Usage Coverage, and Purpose fields without inventing zeros", async () => {
    const run = makeRun("the first prompt");
    let usage = makeContextUsage(run, "WARM");
    const client = makeClient({
      createRun: async () => run,
      getRunContextUsage: async () => usage,
    });
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();
    await controller.submitPrompt("the first prompt");

    await controller.submitPrompt("/context");
    expect(controller.getState().notice).toContain("MAIN_AGENT 暖请求命中率 80%");
    expect(controller.getState().notice).toContain("MAIN_AGENT 全程命中率 80%");
    expect(controller.getState().notice).toContain("Usage Coverage 1 / 2 · PARTIAL");
    expect(controller.getState().notice).toContain("Usage Coverage 诊断");
    expect(controller.getState().notice).toContain("已上报 Token 但无 Hit/Miss 1");
    expect(controller.getState().notice).not.toContain("可复用前缀效率");
    expect(controller.getState().notice).toContain("最近重置 —");
    expect(controller.getState().notice).not.toContain("最近重置 INITIAL");
    expect(controller.getState().notice).toContain("MAIN_AGENT 1 request");
    expect(controller.getState().notice).toContain("COMPACTION 1 request");

    usage = makeContextUsage(run, "COLD_START");
    await controller.submitPrompt("/context");
    expect(controller.getState().notice).toContain("冷启动");
    expect(controller.getState().notice).toContain("MAIN_AGENT 全程命中率 0%");

    usage = makeContextUsage(run, "RESET");
    await controller.submitPrompt("/context");
    expect(controller.getState().notice).toContain("缓存周期 cycle-4");
    expect(controller.getState().notice).toContain("最近重置 COMPACTION_COMMITTED");
    expect(controller.getState().notice).toContain("Step 3");

    usage = makeContextUsage(run, "UNREPORTED");
    await controller.submitPrompt("/context");
    expect(controller.getState().notice).toContain("未上报 usage");
    expect(controller.getState().notice).not.toContain("MAIN_AGENT 全程命中率 0%");
    expect(controller.getState().notice).toContain("MAIN_AGENT 全程命中率 未上报 usage");
    expect(controller.getState().notice).not.toContain("可复用前缀效率");

    usage = { ...makeContextUsage(run, "WARM"), promptCache: undefined };
    await controller.submitPrompt("/context");
    expect(controller.getState().notice).toContain("Context: 50% used");
    expect(controller.getState().notice).not.toContain("MAIN_AGENT 暖请求命中率");
    controller.dispose();
  });

  it("ignores empty prompts and refuses prompts above the UTF-8 bound", async () => {
    const client = makeClient();
    const controller = new CliConversationController({
      client,
      workspacePath: "C:\\workspace\\project",
    });
    await controller.bootstrap();

    await expect(controller.submitPrompt("  ")).resolves.toBe(false);
    await expect(controller.submitPrompt("😀".repeat(300_000))).resolves.toBe(false);
    expect(controller.getState().displayHistory).toEqual([]);
  });

  it("fails safely before Session creation when the daemon is unreachable", async () => {
    let sessionCalls = 0;
    const controller = new CliConversationController({
      client: makeClient({
        getHealth: async () => {
          throw new CaelushClientProtocolError("Daemon request failed: ECONNREFUSED");
        },
        createSession: async () => {
          sessionCalls += 1;
          return makeSession();
        },
      }),
      workspacePath: "C:\\workspace\\project",
    });

    await controller.bootstrap();

    expect(sessionCalls).toBe(0);
    expect(controller.getState()).toMatchObject({
      bootstrap: "BOOTSTRAP_ERROR",
      composerEnabled: false,
      fatalError: "Caelush Local Agent Service is not reachable.",
    });
  });

  it("fails safely before Session creation when public defaults are missing", async () => {
    let sessionCalls = 0;
    const controller = new CliConversationController({
      client: makeClient({
        getInfo: async () => ({ ...makeInfo(), defaultModel: undefined }) as unknown as DaemonInfo,
        createSession: async () => {
          sessionCalls += 1;
          return makeSession();
        },
      }),
      workspacePath: "C:\\workspace\\project",
    });

    await controller.bootstrap();

    expect(sessionCalls).toBe(0);
    expect(controller.getState()).toMatchObject({
      bootstrap: "BOOTSTRAP_ERROR",
      fatalError:
        "Daemon is missing a default model. Set CAELUSH_DEFAULT_PROVIDER and CAELUSH_DEFAULT_MODEL, then restart the daemon.",
    });
  });

  it("explains provider setup when the daemon has no configured providers", async () => {
    const controller = new CliConversationController({
      client: makeClient({
        getInfo: async () =>
          ({
            ...makeInfo(),
            configuredProviders: [],
            defaultModel: undefined,
          }) as unknown as DaemonInfo,
      }),
      workspacePath: "C:\\workspace\\project",
    });

    await controller.bootstrap();

    expect(controller.getState().fatalError).toBe(
      "Daemon is missing a default model. Configure CAELUSH_PROVIDER_ID and CAELUSH_PROVIDER_BASE_URL (and CAELUSH_PROVIDER_API_KEY when required), then set CAELUSH_DEFAULT_PROVIDER and CAELUSH_DEFAULT_MODEL and restart the daemon.",
    );
  });
});

export function makeClient(overrides: Partial<CliDaemonClient> = {}): CliDaemonClient {
  const session = makeSession();
  const run = makeRun("prompt");
  return {
    getHealth: async () => makeHealth(),
    getInfo: async () => makeInfo(),
    createSession: async () => session,
    createRun: async () => run,
    watchRunEvents: async function* () {
      await new Promise<void>(() => undefined);
      yield* [] as PublicRunEvent[];
    },
    startRun: async () => actionResponse(run),
    getRun: async () => run,
    listSessions: async () => ({ items: [session] }),
    getSession: async () => session,
    getSessionTranscript: async () => ({ items: [] }),
    listRuns: async () => ({ items: [] }),
    recoverRun: async () => actionResponse(run),
    cancelRun: async () => actionResponse(run),
    listPendingApprovals: async () => ({ items: [] }),
    resolveApproval: async () => actionResponse(run),
    ...overrides,
  };
}

export function makeInfo(): DaemonInfo {
  return {
    apiVersion: "v1",
    protocolVersion: 1,
    daemonVersion: "0.1.0",
    capabilities: {
      runExecution: true,
      runRecovery: true,
      cancellation: true,
      approvals: true,
      sseReplay: true,
      sessionTranscript: true,
    },
    runtimeKinds: ["local"],
    configuredProviders: ["fixture"],
    defaultModel: { provider: "fixture", model: "fixture-model" },
    defaultRunConfiguration,
  };
}

export function makeHealth(): HealthResponse {
  return {
    service: "caelush-daemon",
    status: "ready",
    apiVersion: "v1",
    protocolVersion: 1,
  };
}

export function makeSession(): ClientAgentSession {
  return {
    id: createSessionId(),
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  };
}

export function makeRun(goal: string): ClientAgentRun {
  return {
    id: createRunId(),
    sessionId: createSessionId(),
    goal,
    status: "PENDING",
    workspace: { id: createWorkspaceId(), path: "C:\\workspace\\project" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: defaultRunConfiguration.limits,
    model: { provider: "fixture", model: "fixture-model" },
    createdAt: 1,
  };
}

function makeContextUsage(
  run: ClientAgentRun,
  status: "WARM" | "COLD_START" | "RESET" | "UNREPORTED",
): ContextUsageProjection {
  const isUnreported = status === "UNREPORTED";
  const isColdStart = status === "COLD_START";
  const hitTokens = isUnreported || isColdStart ? 0 : 400;
  const missTokens = isUnreported ? 0 : isColdStart ? 500 : 100;
  return {
    runId: run.id,
    providerId: "fixture",
    modelId: "small",
    contextWindowTokens: 1000,
    effectiveInputLimitTokens: 800,
    estimatedInputTokens: 400,
    usedRatio: 0.5,
    remainingTokens: 400,
    pressureState: "NORMAL",
    compactionCount: 1,
    breakdown: {
      pinned: 0,
      checkpoint: 0,
      recentTail: 0,
      project: 0,
      files: 0,
      toolObservations: 0,
      memory: 0,
    },
    updatedAt: 1,
    promptCache: {
      status,
      sampleCount: isUnreported ? 0 : 1,
      totalRequestCount: 2,
      totalInputTokens: 560,
      totalOutputTokens: 25,
      hitTokens,
      missTokens,
      writeTokens: 20,
      unknownUsageCount: isUnreported ? 2 : 1,
      ...(isUnreported
        ? {}
        : {
            latestHitRate: isColdStart ? 0 : 0.8,
            rollingHitRate: isColdStart ? 0 : 0.8,
          }),
      expectedReusablePrefixTokens: 500,
      epochId: "cycle-4",
      resetReason: status === "RESET" ? "COMPACTION_COMMITTED" : "INITIAL",
      ...(status === "RESET"
        ? { resetReason: "COMPACTION_COMMITTED" as const, resetStepSequence: 3, resetAt: 4 }
        : {}),
      purposes: [
        {
          purpose: "MAIN_AGENT",
          requestCount: 1,
          inputTokens: 500,
          outputTokens: 20,
          hitTokens,
          missTokens,
          writeTokens: 20,
          reasoningTokens: 0,
          usageFieldCoverage: {
            inputTokens: 1,
            outputTokens: 1,
            hitTokens: isUnreported ? 0 : 1,
            missTokens: isUnreported ? 0 : 1,
            writeTokens: 1,
            reasoningTokens: 0,
          },
          unknownUsageCount: isUnreported ? 1 : 0,
        },
        {
          purpose: "COMPACTION",
          requestCount: 1,
          inputTokens: 60,
          outputTokens: 5,
          hitTokens: 0,
          missTokens: 0,
          writeTokens: 0,
          reasoningTokens: 0,
          usageFieldCoverage: {
            inputTokens: 1,
            outputTokens: 1,
            hitTokens: 0,
            missTokens: 0,
            writeTokens: 0,
            reasoningTokens: 0,
          },
          unknownUsageCount: 1,
        },
      ],
      metricsV2: {
        fullRun: {
          mainAgent: isUnreported
            ? { requestCount: 0, hitTokens: 0, accountedTokens: 0 }
            : {
                requestCount: 1,
                hitTokens,
                accountedTokens: hitTokens + missTokens,
                hitRate:
                  hitTokens + missTokens === 0 ? undefined : hitTokens / (hitTokens + missTokens),
              },
          allPurposes: isUnreported
            ? { requestCount: 0, hitTokens: 0, accountedTokens: 0 }
            : {
                requestCount: 1,
                hitTokens,
                accountedTokens: hitTokens + missTokens,
                hitRate:
                  hitTokens + missTokens === 0 ? undefined : hitTokens / (hitTokens + missTokens),
              },
        },
        warm: {
          mainAgent:
            isUnreported || isColdStart
              ? { requestCount: 0, hitTokens: 0, accountedTokens: 0 }
              : { requestCount: 1, hitTokens: 400, accountedTokens: 500, hitRate: 0.8 },
          allPurposes:
            isUnreported || isColdStart
              ? { requestCount: 0, hitTokens: 0, accountedTokens: 0 }
              : { requestCount: 1, hitTokens: 400, accountedTokens: 500, hitRate: 0.8 },
        },
        rolling: {
          windowSize: 10,
          mainAgent: isUnreported
            ? { requestCount: 0, hitTokens: 0, accountedTokens: 0 }
            : {
                requestCount: 1,
                hitTokens,
                accountedTokens: hitTokens + missTokens,
                hitRate:
                  hitTokens + missTokens === 0 ? undefined : hitTokens / (hitTokens + missTokens),
              },
          allPurposes: isUnreported
            ? { requestCount: 0, hitTokens: 0, accountedTokens: 0 }
            : {
                requestCount: 1,
                hitTokens,
                accountedTokens: hitTokens + missTokens,
                hitRate:
                  hitTokens + missTokens === 0 ? undefined : hitTokens / (hitTokens + missTokens),
              },
        },
        latestRequest: isUnreported
          ? { purpose: "MAIN_AGENT", inputTokens: 500, cacheUsageReported: false }
          : {
              purpose: "MAIN_AGENT",
              inputTokens: 500,
              hitTokens,
              missTokens,
              writeTokens: 20,
              cacheUsageReported: true,
            },
        usageCoverage: {
          observedRequestCount: 2,
          completeCacheUsageCount: isUnreported ? 0 : 1,
          incompleteOrUnknownCount: isUnreported ? 2 : 1,
          providerUsageUnreportedCount: 0,
          providerUsageWithoutCacheBreakdownCount: isUnreported ? 2 : 1,
          failedOrCancelledWithoutUsageCount: 0,
          inProgressInvocationCount: 0,
          missingInvocationRecordCount: isUnreported ? 2 : 1,
          legacyWithoutCacheBreakdownCount: isUnreported ? 2 : 1,
          unidentifiedLegacySampleCount: 0,
          coverageRate: isUnreported ? 0 : 0.5,
          status: isUnreported ? "UNREPORTED" : "PARTIAL",
        },
        surfaceDelta: { availability: "NOT_AVAILABLE_FOR_V2" },
      },
    },
  };
}

export function actionResponse(run: ClientAgentRun) {
  return {
    runId: run.id,
    action: "START" as const,
    disposition: "SCHEDULED" as const,
    run,
  };
}

export function completedEvent(run: ClientAgentRun): PublicRunEvent {
  return {
    eventId: createEventId(),
    schemaVersion: 1,
    type: "run.completed",
    runId: run.id,
    sessionId: run.sessionId,
    stepId: createStepId(),
    timestamp: 2,
    visibility: "USER_VISIBLE",
    durability: { kind: "DURABLE", version: 1, sequence: 1 },
    payload: { result: { type: "VERIFIED_COMPLETION" } },
  } as PublicRunEvent;
}
