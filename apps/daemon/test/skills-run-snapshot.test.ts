import {
  createRunId,
  createWorkspaceId,
  type RunId,
  type SkillSelectionV1,
} from "@caelush/protocol";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createFilesystemSkillBundleStore } from "../src/skills/bundle-store.js";
import {
  createSkillCatalogService,
  type SkillCatalogService,
} from "../src/skills/catalog-service.js";
import { createFilesystemSkillProvider } from "../src/skills/filesystem-provider.js";
import { createSelectedSkillPreparer } from "../src/skills/selected-skill-preparer.js";
import { createRunSkillCatalogSnapshotService } from "../src/skills/run-catalog-snapshot.js";
import { createSubmissionSkillViewService } from "../src/skills/submission-skill-view.js";
import { buildDaemonApp } from "../src/index.js";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";

const workspaceId = createWorkspaceId();
const baseRun = {
  goal: "Review the code",
  workspace: { id: workspaceId, path: "C:/snapshot-workspace" },
  model: { provider: "test", model: "test-model" },
  runtime: { id: "local", kind: "test" },
  preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
  limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 },
};

let root: string | undefined;
let storage: CaelushStorage | undefined;
let app: ReturnType<typeof buildDaemonApp> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await storage?.close();
  storage = undefined;
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Run Skill catalog snapshots", () => {
  it("M05 freezes every Skill bundle and effective same-name winner for old Runs", async () => {
    const fixture = await makeSnapshotFixture();
    const signal = new AbortController().signal;
    const firstRef = await fixture.snapshots.captureRunSkillCatalog({
      runId: createRunId(),
      workspaceId,
      signal,
    });
    const first = await fixture.snapshots.readRunSkillCatalogSnapshot(firstRef);
    const oldWinner = first.skills.find(({ name }) => name === "review-helper")!;
    const unselected = first.skills.find(({ name }) => name === "deferred-helper")!;
    expect(first.complete).toBe(true);
    expect(first.skills).toHaveLength(2);

    await writeSkill(fixture.userRoot, "review-helper", "new user body", "new user guide");
    await writeSkill(
      join(fixture.workspaceRoot, ".agents", "skills"),
      "review-helper",
      "project override",
      "project guide",
    );
    fixture.catalog.invalidate(workspaceId);

    const secondRef = await fixture.snapshots.captureRunSkillCatalog({
      runId: createRunId(),
      workspaceId,
      signal,
    });
    const second = await fixture.snapshots.readRunSkillCatalogSnapshot(secondRef);
    const newWinner = second.skills.find(({ name }) => name === "review-helper")!;
    expect(newWinner.skillId).not.toBe(oldWinner.skillId);
    expect(newWinner.bundle.bundleRevision).not.toBe(oldWinner.bundle.bundleRevision);

    const oldCore = await fixture.bundleStore.read({
      bundle: oldWinner.bundle,
      relativePath: "SKILL.md",
      signal,
    });
    const oldGuide = await fixture.bundleStore.read({
      bundle: unselected.bundle,
      relativePath: "references/guide.md",
      signal,
    });
    expect(oldCore.kind === "TEXT" && oldCore.text).toContain("old review body");
    expect(oldGuide.kind === "TEXT" && oldGuide.text).toBe("old deferred guide");

    const newCore = await fixture.bundleStore.read({
      bundle: newWinner.bundle,
      relativePath: "SKILL.md",
      signal,
    });
    expect(newCore.kind === "TEXT" && newCore.text).toContain("project override");
    const restartedReader = createRunSkillCatalogSnapshotService({
      rootDirectory: fixture.snapshotRoot,
    });
    const restored = await restartedReader.readRunSkillCatalogSnapshot(firstRef);
    expect(restored).toEqual(first);

    const snapshotPath = join(
      fixture.snapshotRoot,
      `${firstRef.manifestFingerprint.slice("sha256:".length)}.json`,
    );
    const storedSnapshot = await readFile(snapshotPath, "utf8");
    expect(storedSnapshot).not.toContain(fixture.userRoot);
    expect(storedSnapshot).not.toContain(fixture.workspaceRoot);
    expect(storedSnapshot).not.toContain("privateLocator");
    await writeFile(snapshotPath, "{corrupted", "utf8");
    await expect(restartedReader.readRunSkillCatalogSnapshot(firstRef)).rejects.toMatchObject({
      reason: "SKILL_ARTIFACT_INVALID",
    });
  });

  it("keeps unselected bundles reachable through a durable Run snapshot after restart", async () => {
    const fixture = await makeSnapshotFixture({ withApp: true });
    const response = await fixture.app!.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {
        ...baseRun,
        submissionId: "0a951808-52cd-4164-9790-b452a0f55e26",
        userText: "keep old unselected skill resources",
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const runId = response.json().id as RunId;
    const profile = await storage!.runs.readWorkflowProfile!(runId);
    const oldSnapshot = await fixture.snapshots.readRunSkillCatalogSnapshot(
      profile!.catalogSnapshotRef,
    );
    const oldDeferred = oldSnapshot.skills.find(({ name }) => name === "deferred-helper")!;
    await expect(
      storage!.runs.isWorkflowArtifactReferenced!(oldDeferred.bundle.artifactRef),
    ).resolves.toBe(false);

    const durableReferences = {
      isReferenced: (artifactRef: string) =>
        storage!.runs.isWorkflowArtifactReferenced!(artifactRef),
    };
    const restartedSnapshotHolder: {
      current: ReturnType<typeof createRunSkillCatalogSnapshotService> | undefined;
    } = { current: undefined };
    const restartedBundleStore = createFilesystemSkillBundleStore({
      rootDirectory: fixture.bundleRoot,
      references: {
        isReferenced: async (reference) => {
          if (await durableReferences.isReferenced(reference.artifactRef)) return true;
          if (restartedSnapshotHolder.current === undefined) return true;
          return restartedSnapshotHolder.current.isBundleArtifactReferenced(reference.artifactRef);
        },
      },
      resolveSource: fixture.resolveSource,
    });
    const restartedSnapshots = createRunSkillCatalogSnapshotService({
      rootDirectory: fixture.snapshotRoot,
      catalog: fixture.catalog,
      bundleStore: restartedBundleStore,
      referenceAuthority: durableReferences,
    });
    restartedSnapshotHolder.current = restartedSnapshots;

    await restartedBundleStore.collectGarbage();
    await writeSkill(fixture.userRoot, "deferred-helper", "updated deferred body", "new guide");
    fixture.catalog.invalidate(workspaceId);
    await restartedSnapshots.captureRunSkillCatalog({
      runId: createRunId(),
      workspaceId,
      signal: new AbortController().signal,
    });

    const oldGuide = await restartedBundleStore.read({
      bundle: oldDeferred.bundle,
      relativePath: "references/guide.md",
      signal: new AbortController().signal,
    });
    expect(oldGuide.kind === "TEXT" && oldGuide.text).toBe("old deferred guide");
  });

  it("restores zero-selection CONTENT_READY and selected display metadata after Storage restart", async () => {
    const fixture = await makeSnapshotFixture({ withApp: true });
    const page = await fixture.catalog.listUserCatalog({
      workspaceId,
      pageSize: 100,
      signal: new AbortController().signal,
    });
    const selected = page.items.find(({ name }) => name === "review-helper")!;
    const selection: SkillSelectionV1 = {
      skillId: selected.skillId,
      selectionToken: selected.selectionToken,
    };
    const exactTarget = await fixture.catalog.resolveUserSelection({
      workspaceId,
      skillId: selected.skillId,
      selectionToken: selected.selectionToken,
      signal: new AbortController().signal,
    });
    const exactBundle = await fixture.bundleStore.capture({
      workspaceId,
      skillId: exactTarget.skillId,
      expectedRevision: exactTarget.bundleRevision,
      signal: new AbortController().signal,
    });
    const exactCore = await fixture.bundleStore.read({
      bundle: exactBundle,
      relativePath: "SKILL.md",
      signal: new AbortController().signal,
    });
    expect(exactCore.kind === "TEXT" && exactCore.text).toContain("old review body");
    const selectedResponse = await fixture.app!.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {
        ...baseRun,
        submissionId: "24d9af77-4b54-4e30-9956-ff8f0c1699c0",
        userText: "restore this exact user draft",
        skillSelections: [selection],
      },
    });
    expect(selectedResponse.statusCode, selectedResponse.body).toBe(201);
    const selectedRunId = selectedResponse.json().id as RunId;
    await expect(storage!.runs.get(selectedRunId)).resolves.toMatchObject({ status: "PENDING" });
    const selectedEvents = await storage!.eventReader.replay(selectedRunId, {
      afterSequence: 0,
      throughSequence: await storage!.eventReader.latestSequence(selectedRunId),
      limit: 10,
    });
    expect(selectedEvents.some(({ type }) => type === "run.started")).toBe(false);

    await writeSkill(fixture.userRoot, "review-helper", "new user body", "new user guide");
    await writeSkill(
      join(fixture.workspaceRoot, ".agents", "skills"),
      "review-helper",
      "project override",
      "project guide",
    );
    fixture.catalog.invalidate(workspaceId);
    const emptyResponse = await fixture.app!.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {
        ...baseRun,
        submissionId: "00b5509e-11d0-4e7b-a0dd-a6fa5e5b4ed1",
        userText: "restore this zero-selection draft",
      },
    });
    expect(emptyResponse.statusCode, emptyResponse.body).toBe(201);
    const emptyRunId = emptyResponse.json().id as RunId;
    await expect(storage!.runs.get(emptyRunId)).resolves.toMatchObject({ status: "PENDING" });
    const emptyEvents = await storage!.eventReader.replay(emptyRunId, {
      afterSequence: 0,
      throughSequence: await storage!.eventReader.latestSequence(emptyRunId),
      limit: 10,
    });
    expect(emptyEvents.some(({ type }) => type === "run.started")).toBe(false);
    const selectedProfile = await storage!.runs.readWorkflowProfile!(selectedRunId);
    const emptyProfile = await storage!.runs.readWorkflowProfile!(emptyRunId);
    expect(selectedProfile?.catalogSnapshotRef.artifactRef).not.toBe(
      emptyProfile?.catalogSnapshotRef.artifactRef,
    );
    const selectedBindings = await storage!.runs.readPreparedResources!(selectedRunId);
    expect(selectedBindings).toHaveLength(1);
    const selectedBundle = {
      bundleRevision: selectedBindings[0]!.resourceRevision,
      artifactRef: selectedBindings[0]!.artifactRef,
      manifestFingerprint: selectedBindings[0]!.sourceFingerprint,
    };
    const boundCore = await fixture.bundleStore.read({
      bundle: selectedBundle,
      relativePath: "SKILL.md",
      signal: new AbortController().signal,
    });
    expect(boundCore.kind === "TEXT" && boundCore.text).toContain("old review body");

    await fixture.app!.close();
    app = undefined;
    await storage!.close();
    storage = undefined;
    storage = await openCaelushStorage({ path: fixture.databasePath });
    fixture.bundleStore = createFilesystemSkillBundleStore({
      rootDirectory: fixture.bundleRoot,
      resolveSource: fixture.resolveSource,
    });
    const restartedSnapshots = createRunSkillCatalogSnapshotService({
      rootDirectory: fixture.snapshotRoot,
    });
    const restoredEmptySnapshot = await restartedSnapshots.readRunSkillCatalogSnapshot(
      emptyProfile!.catalogSnapshotRef,
    );
    expect(
      restoredEmptySnapshot.skills.find(({ name }) => name === "review-helper")?.skillId,
    ).not.toBe(selected.skillId);
    const restoredEmptyWinner = restoredEmptySnapshot.skills.find(
      ({ name }) => name === "review-helper",
    )!;
    const restoredProjectCore = await fixture.bundleStore.read({
      bundle: restoredEmptyWinner.bundle,
      relativePath: "SKILL.md",
      signal: new AbortController().signal,
    });
    expect(restoredProjectCore.kind === "TEXT" && restoredProjectCore.text).toContain(
      "project override",
    );
    const view = createSubmissionSkillViewService({
      runs: storage.runs,
      readCatalogSnapshot: (reference) => restartedSnapshots.readRunSkillCatalogSnapshot(reference),
    });
    app = buildAppForRecovery(fixture, view);
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {},
    });
    const recoverySessionId = session.json().id as string;

    const selectedRecovery = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${fixture.sessionId}/runs/${selectedRunId}/skill-preparation`,
      headers: { host: "127.0.0.1" },
    });
    expect(selectedRecovery.statusCode, selectedRecovery.body).toBe(200);
    expect(selectedRecovery.json()).toMatchObject({
      schemaVersion: 1,
      runId: selectedRunId,
      userText: "restore this exact user draft",
      preparationStatus: "CONTENT_READY",
      selectedSkills: [{ skillId: selected.skillId, name: "review-helper" }],
    });
    expect(JSON.stringify(selectedRecovery.json())).not.toMatch(
      /old review body|privateLocator|source|root|path|selectionToken|artifactRef|LOADED/u,
    );

    const emptyRecovery = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${fixture.sessionId}/runs/${emptyRunId}/skill-preparation`,
      headers: { host: "127.0.0.1" },
    });
    expect(emptyRecovery.statusCode, emptyRecovery.body).toBe(200);
    expect(emptyRecovery.json()).toEqual({
      schemaVersion: 1,
      runId: emptyRunId,
      userText: "restore this zero-selection draft",
      preparationStatus: "CONTENT_READY",
      selectedSkills: [],
    });

    const wrongSession = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${recoverySessionId}/runs/${selectedRunId}/skill-preparation`,
      headers: { host: "127.0.0.1" },
    });
    expect(wrongSession.statusCode).toBe(404);
  });

  it("does not fabricate workflow profiles for a new Run while Skills are OFF", async () => {
    const fixture = await makeSnapshotFixture({ withApp: true, skillEnabled: false });
    const response = await fixture.app!.inject({
      method: "POST",
      url: `/api/v1/sessions/${fixture.sessionId}/runs`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: baseRun,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(await storage!.runs.readWorkflowProfile!(response.json().id as RunId)).toBeNull();
    expect(await storage!.runs.readPreparedResources!(response.json().id as RunId)).toEqual([]);
  });
});

async function makeSnapshotFixture(
  options: { readonly withApp?: boolean; readonly skillEnabled?: boolean } = {},
) {
  root = await mkdtemp(join(tmpdir(), "caelush-run-skill-snapshot-"));
  const userRoot = join(root, "user-skills");
  const workspaceRoot = join(root, "workspace");
  const snapshotRoot = join(root, "catalog-snapshots");
  const bundleRoot = join(root, "bundles");
  const databasePath = join(root, "caelush.db");
  await writeSkill(userRoot, "review-helper", "old review body", "old review guide");
  await writeSkill(userRoot, "deferred-helper", "deferred body", "old deferred guide");
  await mkdir(join(workspaceRoot, ".agents", "skills"), { recursive: true });
  storage = await openCaelushStorage({ path: databasePath });
  const provider = createFilesystemSkillProvider({
    userRoot,
    resolveWorkspaceRoot: async () => workspaceRoot,
  });
  const catalog = createSkillCatalogService({ provider, settings: storage.skillSettings });
  const resolveSource = async (
    skillId: string,
    requestedWorkspaceId?: string,
    candidateOverride?: import("@caelush/skills").SkillCandidate,
  ) => {
    if (requestedWorkspaceId === undefined) return null;
    const candidate =
      candidateOverride ??
      (
        await provider.discover({
          workspaceId: requestedWorkspaceId,
          signal: new AbortController().signal,
        })
      ).candidates.find((entry) => entry.skillId === skillId);
    if (candidate === undefined || candidate.skillId !== skillId) return null;
    const locator = await provider.resolveLocator(candidate.privateLocator, requestedWorkspaceId);
    if (locator === null) return null;
    return {
      candidate,
      scopeId: candidate.providerId,
      rootDirectory: locator.rootDirectory,
      packageDirectory: locator.packageDirectory,
    };
  };
  const bundleStore = createFilesystemSkillBundleStore({
    rootDirectory: bundleRoot,
    resolveSource,
  });
  const snapshots = createRunSkillCatalogSnapshotService({
    rootDirectory: snapshotRoot,
    catalog,
    bundleStore,
  });
  const fixture = {
    root,
    userRoot,
    workspaceRoot,
    snapshotRoot,
    bundleRoot,
    resolveSource,
    databasePath,
    provider,
    catalog,
    bundleStore,
    snapshots,
    sessionId: "ses_00000000-0000-7000-8000-000000000000",
    app: undefined as ReturnType<typeof buildDaemonApp> | undefined,
  };
  if (options.withApp) {
    const preparer = createSelectedSkillPreparer({
      catalog,
      bundleStore,
      captureCatalogSnapshot: async (input) => {
        const snapshot = await snapshots.captureRunSkillCatalog(input);
        return {
          catalogRevision: snapshot.catalogRevision,
          artifactRef: snapshot.artifactRef,
          manifestFingerprint: snapshot.manifestFingerprint,
        };
      },
    });
    app = buildAppForPreparation(fixture, preparer, options.skillEnabled ?? true);
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: {},
    });
    fixture.sessionId = session.json().id as string;
    fixture.app = app;
  }
  return fixture;
}

function buildAppForPreparation(
  fixture: { catalog: SkillCatalogService },
  preparer: ReturnType<typeof createSelectedSkillPreparer>,
  skillEnabled: boolean,
) {
  return buildDaemonApp({
    sessions: storage!.sessions,
    runs: storage!.runs,
    submissions: storage!.submissions,
    skillCatalog: fixture.catalog,
    selectedSkillPreparer: preparer,
    submissionSkillView: undefined,
    skillFeatureReadiness: {
      enabled: skillEnabled,
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
}

function buildAppForRecovery(
  fixture: { catalog: SkillCatalogService },
  view: ReturnType<typeof createSubmissionSkillViewService>,
) {
  return buildDaemonApp({
    sessions: storage!.sessions,
    runs: storage!.runs,
    submissions: storage!.submissions,
    skillCatalog: fixture.catalog,
    submissionSkillView: view,
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
}

async function writeSkill(
  rootDirectory: string,
  name: string,
  body: string,
  guide: string,
): Promise<void> {
  const directory = join(rootDirectory, name);
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} instructions\nuser-invocable: true\n---\n${body}`,
  );
  await writeFile(join(directory, "references", "guide.md"), guide);
}
