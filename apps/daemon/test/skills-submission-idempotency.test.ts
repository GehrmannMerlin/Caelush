import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, type RunId } from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDaemonApp } from "../src/index.js";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";

let storage: CaelushStorage | undefined;
let directory: string | undefined;
let app: ReturnType<typeof buildDaemonApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await storage?.close();
  storage = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const baseRun = {
  goal: "Review the code",
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  model: { provider: "test", model: "test-model" },
  runtime: { id: "local", kind: "test" },
  preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
  limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
};

const selection = (token: string) => ({ skillId: "skill:review", selectionToken: token });

describe("Skill submission idempotency", () => {
  it("M02 reuses the committed Run and bundle without recapturing the current Skill revision", async () => {
    let latestRevision = "sha256:revision-one";
    const fixture = await makeApp(({ runId }) => profileAndBinding(runId, latestRevision));
    const request = {
      ...baseRun,
      submissionId: "eea4df74-2f55-4f47-ae12-868eb0fc71ca",
      skillSelections: [selection("A".repeat(43))],
    };
    const first = await postRun(fixture.app, fixture.sessionId, request);
    latestRevision = "sha256:revision-two";
    const retry = await postRun(fixture.app, fixture.sessionId, request);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(fixture.prepare).toHaveBeenCalledOnce();
    const bindings = await storage!.runs.readPreparedResources!(first.json().id as RunId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.resourceRevision).toBe("sha256:revision-one");
    expect(await storage!.runs.listBySession(fixture.sessionId as never)).toHaveLength(1);
    expect(await storage!.eventReader.latestSequence(first.json().id as RunId)).toBe(1);
  });

  it("includes normalized selection identity in the reserved payload hash", async () => {
    const fixture = await makeApp(({ runId }) => profileAndBinding(runId, "sha256:revision-one"));
    const submissionId = "ea2c82ac-2eba-4be4-9c42-74fbdfaa8c56";
    const one = selection("B".repeat(43));
    const first = await postRun(fixture.app, fixture.sessionId, {
      ...baseRun,
      submissionId,
      skillSelections: [one, one],
    });
    const duplicateNormalizedRetry = await postRun(fixture.app, fixture.sessionId, {
      ...baseRun,
      submissionId,
      skillSelections: [one],
    });
    expect(first.statusCode).toBe(201);
    expect(duplicateNormalizedRetry.json()).toEqual(first.json());
    expect(fixture.prepare).toHaveBeenCalledOnce();

    const changedToken = await postRun(fixture.app, fixture.sessionId, {
      ...baseRun,
      submissionId,
      skillSelections: [selection("C".repeat(43))],
    });
    expect(changedToken.statusCode).toBe(409);
    expect(changedToken.json().error.code).toBe("CONFLICT");
    expect(fixture.prepare).toHaveBeenCalledOnce();
  });

  it("M03 commits only one Run, binding and durable event for concurrent identical submissions", async () => {
    const fixture = await makeApp(async ({ runId }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return profileAndBinding(runId, "sha256:revision-one");
    });
    const request = {
      ...baseRun,
      submissionId: "6f1ff7e5-9a46-4fea-93dd-0507c2423d05",
      skillSelections: [selection("D".repeat(43))],
    };

    const [left, right] = await Promise.all([
      postRun(fixture.app, fixture.sessionId, request),
      postRun(fixture.app, fixture.sessionId, request),
    ]);
    expect(left.statusCode).toBe(201);
    expect(right.statusCode).toBe(201);
    expect(left.json()).toEqual(right.json());
    const runId = left.json().id as RunId;
    expect(await storage!.runs.listBySession(fixture.sessionId as never)).toHaveLength(1);
    expect(await storage!.runs.readPreparedResources!(runId)).toHaveLength(1);
    await expect(storage!.runs.readWorkflowProfile!(runId)).resolves.toMatchObject({ runId });
    expect(await storage!.eventReader.latestSequence(runId)).toBe(1);
    expect((await storage!.submissions.get(request.submissionId as never))?.runId).toBe(runId);
  });

  it("allows a changed selection to retry the same empty Session with a fresh submission ID", async () => {
    const fixture = await makeApp(({ runId }) => profileAndBinding(runId, "sha256:revision-one"));
    const staleRequest = {
      ...baseRun,
      submissionId: "c24a3201-422e-4c9e-8c7b-9709eb302481",
      skillSelections: [selection("E".repeat(43))],
    };
    const stale = await postRun(fixture.app, fixture.sessionId, staleRequest);
    const selectedAgain = await postRun(fixture.app, fixture.sessionId, {
      ...baseRun,
      submissionId: "d82dbaff-266b-4da2-a41c-c9022f504d31",
      skillSelections: [selection("F".repeat(43))],
    });

    expect(stale.statusCode).toBe(201);
    expect(selectedAgain.statusCode).toBe(201);
    expect(selectedAgain.json().id).not.toBe(stale.json().id);
    expect(await storage!.runs.listBySession(fixture.sessionId as never)).toHaveLength(2);
  });
});

function profileAndBinding(runId: RunId, revision: string) {
  return {
    workflowProfile: {
      runId,
      profileVersion: 1 as const,
      workflowRendererVersion: "workflow-resource@1",
      catalogSnapshotRef: {
        catalogRevision: "catalog-1",
        artifactRef: "workflow:snapshot",
        manifestFingerprint: "sha256:snapshot",
      },
    },
    bindingsInSelectionOrder: [
      {
        runId,
        resourceKind: "WORKFLOW_INSTRUCTION" as const,
        resourceId: "skill:review",
        resourceRevision: revision,
        artifactRef: "skill:bundle",
        sourceFingerprint: "sha256:manifest",
        utf8Bytes: 12,
        tokenEstimate: 4,
      },
    ],
    renderedCoreBudget: {
      selectedCount: 1,
      coreUtf8Bytes: 12,
      tokenEstimate: 4,
      maxCoreUtf8Bytes: 64 * 1024,
      maxActiveCoreUtf8Bytes: 256 * 1024,
    },
    selectionDisplaySnapshot: [{ skillId: "skill:review", name: "review" }],
  };
}

async function makeApp(prepare: (input: { readonly runId: RunId }) => unknown | Promise<unknown>) {
  directory = await mkdtemp(join(tmpdir(), "caelush-skill-submission-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const prepareSpy = vi.fn(prepare);
  app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    submissions: storage.submissions,
    selectedSkillPreparer: { prepare: prepareSpy } as never,
    skillFeatureReadiness: {
      enabled: true,
      catalogReady: true,
      invocationReady: false,
      scriptExecutionReady: false,
      presentationReady: false,
    },
    eventHub: { watch: async function* () {} } as never,
    contextBudgetPolicyResolver: {
      resolve: async () => ({
        version: "ADAPTIVE_V1" as const,
        outputReserveTokens: 16_384,
        safetyReserveTokens: 4_096,
      }),
    },
    securityCapabilityService: new SecurityCapabilityService({
      processSandboxProviders: [
        {
          id: "fixture-restricted",
          kind: "RESTRICTED",
          enforcement: "HARD",
          create: async () => ({}) as never,
          probe: async () => ({ available: true, enforcement: "HARD" }),
        },
      ],
    }),
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
  } as never);
  const session = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    payload: {},
  });
  return { app, sessionId: session.json().id as string, prepare: prepareSpy };
}

function postRun(
  targetApp: ReturnType<typeof buildDaemonApp>,
  sessionId: string,
  payload: unknown,
) {
  return targetApp.inject({
    method: "POST",
    url: `/api/v1/sessions/${sessionId}/runs`,
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    payload,
  });
}
