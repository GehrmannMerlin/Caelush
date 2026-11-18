import {
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  DaemonInfoSchema,
  type SubmissionSkillPreparationV1,
  SubmissionIdSchema,
  createRunId,
  createSessionId,
  createWorkspaceId,
  type ClientAgentRun,
  type ClientAgentSession,
  type DaemonInfo,
  type RunActionResponse,
  type WorkspaceRef,
} from "@caelush/protocol";
import type { WebSessionClient } from "../src/application/session-manager.js";
import { WebSessionManager } from "../src/application/session-manager.js";
import { describe, expect, it, vi } from "vitest";

const workspace: WorkspaceRef = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
const submissionId = SubmissionIdSchema.parse("018f6f31-a987-7abc-9def-0123456789ab");
const skillSelections = [{ skillId: "user:review-notes", selectionToken: "opaque-skill-token" }];

function makeInfo(): DaemonInfo {
  return DaemonInfoSchema.parse({
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
    defaultRunConfiguration: {
      runtime: { id: "local", kind: "local" },
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    },
  });
}

function makeSession(): ClientAgentSession {
  return ClientAgentSessionSchema.parse({
    id: createSessionId(),
    workspaceId: workspace.id,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  });
}

function makeRun(
  sessionId: ClientAgentSession["id"],
  status: ClientAgentRun["status"],
): ClientAgentRun {
  return ClientAgentRunSchema.parse({
    id: createRunId(),
    sessionId,
    goal: "Review this change.",
    status,
    workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    createdAt: 1,
  });
}

function createClient(session: ClientAgentSession) {
  let run = makeRun(session.id, "PENDING");
  const client = {
    listSessions: vi.fn(async () => ({ items: [session] })),
    listWorkspaceSessions: vi.fn(async () => ({ items: [{ session, lastActivityAt: 1 }] })),
    listRuns: vi.fn(async () => ({ items: [] })),
    getSession: vi.fn(async () => session),
    createSession: vi.fn(async () => session),
    createRun: vi.fn(
      async (_sessionId: string, input: { skillSelections?: typeof skillSelections }) => {
        expect(input.skillSelections).toEqual(skillSelections);
        return run;
      },
    ),
    getRun: vi.fn(async () => run),
    getSessionTranscript: vi.fn(async () => ({ items: [] })),
    getSessionContinuityPreflight: vi.fn(async () => ({ status: "NO_OBVIOUS_GAP" as const })),
    getSessionTurnPresentation: vi.fn(async () => ({
      capabilityVersion: 1 as const,
      items: [],
      highWatermark: 0,
    })),
    startRun: vi.fn(async (runId: ClientAgentRun["id"]): Promise<RunActionResponse> => {
      run = makeRun(session.id, "RUNNING");
      return { runId, action: "START", disposition: "SCHEDULED", run };
    }),
    watchRunEvents: vi.fn(async function* (
      _runId: ClientAgentRun["id"],
      options?: { readonly signal?: AbortSignal; readonly onOpen?: () => void },
    ) {
      options?.onOpen?.();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    }),
  } as unknown as WebSessionClient & {
    readonly createSession: ReturnType<typeof vi.fn>;
    readonly createRun: ReturnType<typeof vi.fn>;
    readonly startRun: ReturnType<typeof vi.fn>;
    getSubmissionSkillPreparation: ReturnType<typeof vi.fn>;
  };
  return client;
}

describe("WebSessionManager Skill submission", () => {
  it("attaches Skills only to createRun when it creates the first Session", async () => {
    const session = makeSession();
    const client = createClient(session);
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    manager.beginDraft();

    await manager.submitPrompt({ text: "Review this change.", skillSelections, submissionId });

    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.createSession.mock.calls[0]?.[0]).not.toHaveProperty("skillSelections");
    expect(client.createRun).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ skillSelections }),
    );
    manager.dispose();
  });

  it("attaches Skills only to createRun for an existing Session", async () => {
    const session = makeSession();
    const client = createClient(session);
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await manager.selectSession(session.id);

    await manager.submitPrompt({ text: "Review this change.", skillSelections, submissionId });

    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.createRun).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ skillSelections }),
    );
    manager.dispose();
  });

  it("keeps Skill-only submission under the existing text-or-attachment requirement", async () => {
    const session = makeSession();
    const client = createClient(session);
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    manager.beginDraft();

    await expect(manager.submitPrompt({ text: "", skillSelections, submissionId })).resolves.toBe(
      false,
    );
    expect(client.createRun).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("refreshes preparation only from a receipt for the selected Session and Run", async () => {
    const session = makeSession();
    const run = makeRun(session.id, "RUNNING");
    const receipt: SubmissionSkillPreparationV1 = {
      schemaVersion: 1,
      runId: run.id,
      userText: "Review this change.",
      preparationStatus: "CONTENT_READY",
      selectedSkills: [{ skillId: "user:review-notes", name: "review-notes" }],
    };
    const client = createClient(session);
    client.getSubmissionSkillPreparation = vi.fn(async () => receipt);
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await manager.selectSession(session.id);

    await manager.refreshSkillPreparation(session.id, run.id);

    expect(client.getSubmissionSkillPreparation).toHaveBeenCalledWith(session.id, run.id);
    expect(manager.getSnapshot().skillPreparation).toEqual(receipt);
    manager.dispose();
  });

  it("ignores a late preparation receipt after the selected Session changes", async () => {
    const session = makeSession();
    const run = makeRun(session.id, "RUNNING");
    const gate = deferred<SubmissionSkillPreparationV1>();
    const client = createClient(session);
    client.getSubmissionSkillPreparation = vi.fn(() => gate.promise);
    const manager = new WebSessionManager({ client, workspace, info: makeInfo() });
    await manager.loadSessions();
    await manager.selectSession(session.id);

    const refresh = manager.refreshSkillPreparation(session.id, run.id);
    manager.beginDraft();
    gate.resolve({
      schemaVersion: 1,
      runId: run.id,
      userText: "Review this change.",
      preparationStatus: "CONTENT_READY",
      selectedSkills: [{ skillId: "user:review-notes", name: "review-notes" }],
    });
    await refresh;

    expect(manager.getSnapshot().skillPreparation).toBeUndefined();
    manager.dispose();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
