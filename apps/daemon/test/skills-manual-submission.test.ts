import {
  CreateRunRequestSchema,
  CreateSessionRequestSchema,
  createWorkspaceId,
  type SkillSelectionV1,
  type RunId,
} from "@caelush/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDaemonApp } from "../src/index.js";
import { createSkillIdentity, type SkillCandidate, type SkillProviderPort } from "@caelush/skills";
import {
  createSkillCatalogService,
  createSkillSelectionTokenCodec,
  type SkillCatalogService,
} from "../src/skills/catalog-service.js";
import { SkillServiceError } from "../src/skills/feature-policy.js";
import {
  createSelectedSkillPreparer,
  type SelectedSkillPreparer,
} from "../src/skills/selected-skill-preparer.js";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";

const baseRun = {
  goal: "Review the code",
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  model: { provider: "test", model: "test-model" },
  runtime: { id: "local", kind: "test" },
  preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
  limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
};

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

describe("Skill manual Run submission contract", () => {
  it("accepts optional explicit selections on Run creation", () => {
    const parsed = CreateRunRequestSchema.safeParse({
      ...baseRun,
      submissionId: "eea4df74-2f55-4f47-ae12-868eb0fc71ca",
      skillSelections: [
        {
          skillId: "project:review-helper",
          selectionToken: "A".repeat(43),
        },
      ],
    });

    expect(parsed, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toMatchObject({
      success: true,
    });
    if (parsed.success) expect(parsed.data.skillSelections).toHaveLength(1);
  });

  it("keeps createSession metadata-only and rejects Skill selections", () => {
    const parsed = CreateSessionRequestSchema.safeParse({
      skillSelections: [{ skillId: "project:review-helper", selectionToken: "A".repeat(43) }],
    });

    expect(parsed.success).toBe(false);
  });

  it("does not reserve a submission for a missing Session", async () => {
    const fixture = await makeApp({ enabled: false, catalogReady: false });
    const submissionId = "ba84839d-cf78-4d29-959d-92af2bd54e89";
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/sessions/ses_00000000-0000-7000-8000-000000000000/runs",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { ...baseRun, submissionId },
    });

    expect(response.statusCode).toBe(404);
    await expect(storage!.submissions.get(submissionId as never)).resolves.toBeNull();
  });

  it("commits the selected preparation with the Run while keeping Skill fields out of AgentRun", async () => {
    const fixture = await makeApp({ enabled: true, catalogReady: true });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {
        ...baseRun,
        submissionId: "eea4df74-2f55-4f47-ae12-868eb0fc71ca",
        skillSelections: [{ skillId: "skill:review", selectionToken: "A".repeat(43) }],
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).not.toHaveProperty("skillSelections");
    expect(JSON.stringify(response.json())).not.toMatch(/selectionToken|workflow:|artifactRef/u);
    const runId = response.json().id as RunId;
    await expect(storage!.runs.readWorkflowProfile?.(runId)).resolves.toMatchObject({
      runId,
      catalogSnapshotRef: { artifactRef: "workflow:snapshot" },
    });
    await expect(storage!.runs.readPreparedResources?.(runId)).resolves.toEqual([]);
    await expect(storage!.eventReader.latestSequence(runId)).resolves.toBe(1);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
  });

  it("captures the workflow profile for enabled Runs with no manual selections", async () => {
    const fixture = await makeApp({ enabled: true, catalogReady: true });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: baseRun,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(fixture.prepare).toHaveBeenCalledWith(expect.objectContaining({ selections: [] }));
    await expect(
      storage!.runs.readWorkflowProfile?.(response.json().id as RunId),
    ).resolves.toBeDefined();
  });

  it("rejects all manual selections before Run or event insertion when preparation fails", async () => {
    const fixture = await makeApp({ enabled: true, catalogReady: true }, "SKILL_LOAD_FAILED");
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {
        ...baseRun,
        submissionId: "ea2c82ac-2eba-4be4-9c42-74fbdfaa8c56",
        skillSelections: [
          { skillId: "skill:available", selectionToken: "B".repeat(43) },
          { skillId: "skill:unreadable", selectionToken: "C".repeat(43) },
        ],
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.details).toEqual({ reason: "SKILL_LOAD_FAILED" });
    expect(await storage!.runs.listBySession(fixture.sessionId as never)).toEqual([]);
    expect(fixture.prepare).toHaveBeenCalledOnce();
  });

  it("rejects selections while Skill capability is OFF or not ready", async () => {
    for (const readiness of [
      { enabled: false, catalogReady: false },
      { enabled: true, catalogReady: false },
    ]) {
      const fixture = await makeApp(readiness);
      const response = await fixture.app.inject({
        method: "POST",
        url: `/api/v1/sessions/${fixture.sessionId}/runs`,
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        payload: {
          ...baseRun,
          submissionId: "6f1ff7e5-9a46-4fea-93dd-0507c2423d05",
          skillSelections: [{ skillId: "skill:review", selectionToken: "D".repeat(43) }],
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.details).toEqual({ reason: "SKILLS_UNAVAILABLE" });
      expect(await storage!.runs.listBySession(fixture.sessionId as never)).toEqual([]);
      await fixture.app.close();
      app = undefined;
      await storage!.close();
      storage = undefined;
      await rm(directory!, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("M04 rejects a selection token after a workspace switch or token forgery", async () => {
    const workspaceId = createWorkspaceId();
    const providerId = `project:${workspaceId}`;
    const privateLocator = "opaque-fixture-locator";
    const candidate: SkillCandidate = {
      skillId: createSkillIdentity({ scopeRank: 0, providerId, privateLocator }),
      manifest: {
        name: "review-helper",
        description: "Review helper",
        body: "",
        userInvocable: true,
        modelInvocable: true,
      },
      scopeRank: 0,
      providerId,
      privateLocator,
      bundleRevision: `sha256:${"a".repeat(64)}`,
    };
    const provider: SkillProviderPort = {
      discover: async ({ workspaceId: requestedWorkspace }) => ({
        candidates: requestedWorkspace === workspaceId ? [candidate] : [],
        diagnostics: [],
        complete: true,
      }),
    };
    const tokenCodec = createSkillSelectionTokenCodec(new Uint8Array(32).fill(9));
    const fixture = await makeApp(
      { enabled: true, catalogReady: true },
      undefined,
      (currentStorage) => {
        const catalog = createSkillCatalogService({
          provider,
          settings: currentStorage.skillSettings,
          selectionTokens: tokenCodec,
        });
        return {
          catalog,
          preparer: createSelectedSkillPreparer({
            catalog,
            bundleStore: {
              capture: async () => ({
                bundleRevision: candidate.bundleRevision!,
                artifactRef: "skill:fixture-bundle",
                manifestFingerprint: `sha256:${"b".repeat(64)}`,
              }),
              read: async () => ({
                kind: "TEXT" as const,
                relativePath: "SKILL.md",
                contentType: "text/markdown",
                fingerprint: `sha256:${"b".repeat(64)}`,
                complete: true,
                text: "---\nname: review-helper\ndescription: Review helper\nuser-invocable: true\n---\nCheck the code.",
              }),
            },
            captureCatalogSnapshot: async ({ workspaceId: snapshotWorkspaceId }) => {
              const page = await catalog.listUserCatalog({
                workspaceId: snapshotWorkspaceId,
                pageSize: 100,
                signal: new AbortController().signal,
              });
              return {
                catalogRevision: page.catalogRevision,
                artifactRef: "workflow:fixture-catalog",
                manifestFingerprint: `sha256:${"c".repeat(64)}`,
              };
            },
          }),
        };
      },
    );
    const page = await fixture.catalog!.listUserCatalog({
      workspaceId,
      pageSize: 100,
      signal: new AbortController().signal,
    });
    const selection: SkillSelectionV1 = {
      skillId: candidate.skillId,
      selectionToken: page.items[0]!.selectionToken,
    };

    const switchedWorkspace = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {
        ...baseRun,
        workspace: { ...baseRun.workspace, id: createWorkspaceId() },
        submissionId: "2013ab4a-d455-4944-9623-e17728b22e0e",
        skillSelections: [selection],
      },
    });
    expect(switchedWorkspace.statusCode).toBe(404);
    expect(switchedWorkspace.json().error.details).toEqual({ reason: "SKILL_NOT_FOUND" });

    const forgedToken = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {
        ...baseRun,
        workspace: { ...baseRun.workspace, id: workspaceId },
        submissionId: "d2350c1d-7262-4825-8c20-4df8595fba37",
        skillSelections: [{ ...selection, selectionToken: "D".repeat(43) }],
      },
    });
    expect(forgedToken.statusCode).toBe(409);
    expect(forgedToken.json().error.details).toEqual({ reason: "SKILL_SELECTION_STALE" });
    expect(await storage!.runs.listBySession(fixture.sessionId as never)).toEqual([]);
  });
});

async function makeApp(
  readiness: { readonly enabled: boolean; readonly catalogReady: boolean },
  preparationFailure?: "SKILL_LOAD_FAILED",
  preparerFactory?: (storage: CaelushStorage) => {
    readonly preparer: SelectedSkillPreparer;
    readonly catalog: SkillCatalogService;
  },
) {
  directory = await mkdtemp(join(tmpdir(), "caelush-manual-skill-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const prepare = vi.fn(
    async ({
      runId,
      selections,
    }: {
      readonly runId: RunId;
      readonly selections: readonly { readonly skillId: string }[];
    }) => {
      if (preparationFailure !== undefined) throw new SkillServiceError(preparationFailure);
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
        bindingsInSelectionOrder: [],
        renderedCoreBudget: {
          selectedCount: selections.length,
          coreUtf8Bytes: 0,
          tokenEstimate: 0,
          maxCoreUtf8Bytes: 64 * 1024,
          maxActiveCoreUtf8Bytes: 256 * 1024,
        },
        selectionDisplaySnapshot: [{ skillId: "skill:review", name: "review" }],
      };
    },
  );
  const customPreparer = preparerFactory?.(storage);
  const preparer = customPreparer?.preparer ?? { prepare };
  app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    submissions: storage.submissions,
    selectedSkillPreparer: preparer as never,
    skillFeatureReadiness: {
      enabled: readiness.enabled,
      catalogReady: readiness.catalogReady,
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
  return {
    app,
    sessionId: session.json().id as string,
    prepare,
    ...(customPreparer === undefined ? {} : { catalog: customPreparer.catalog }),
  };
}
