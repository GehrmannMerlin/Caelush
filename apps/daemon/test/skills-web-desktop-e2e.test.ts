import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceId, SubmissionIdSchema } from "@caelush/protocol";
import { CaelushClient, CaelushClientHttpError, isTerminalRunStatus } from "@caelush/client";
import type { ApiAdapter } from "@caelush/ai";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandle } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: DaemonHandle | undefined;

const unusedFixtureAdapter: ApiAdapter = {
  id: FIXTURE_API,
  async *stream() {
    fixtureProviderCalls += 1;
    yield { type: "text.delta", payload: { text: "Fixture review complete." } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  },
};
let fixtureProviderCalls = 0;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  daemon = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Skill management through shared Web and Desktop client APIs", () => {
  it("imports and changes manual-only settings while retaining the old package after a failed replacement", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-skills-shared-hosts-"));
    daemon = await startDaemon({
      databasePath: join(directory, "caelush.db"),
      port: 0,
      sseHeartbeatIntervalMs: 0,
      environment: { CAELUSH_FEATURE_SKILLS_V1: "1" },
      providerBindings: [fixtureBinding()],
      modelSources: [fixtureModelSource()],
      adapterOverrides: [unusedFixtureAdapter],
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });

    const webClient = new CaelushClient({ baseUrl: daemon.url });
    const desktopClient = new CaelushClient({ baseUrl: daemon.url });
    const session = await webClient.createSession({
      title: "skills-preview",
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "fixture", model: "fixture-model" },
      metadata: {},
    });
    const workspace = session.defaultWorkspace;
    if (workspace === undefined) throw new Error("the daemon did not return a WorkspaceRef");

    await expect(webClient.getSkillCapabilities()).resolves.toMatchObject({
      enabled: true,
      catalog: true,
      invocation: true,
    });
    const installed = await desktopClient.importSkills(workspace.id, {
      target: "CURRENT_PROJECT",
      files: [
        {
          relativePath: "SKILL.md",
          file: new Blob([
            "---\nname: review-helper\ndescription: Review the patch.\n---\nprivate body",
          ]),
        },
      ],
    });
    const beforeFailedReplacement = await webClient.listManagedSkills(workspace.id);
    expect(beforeFailedReplacement.items).toContainEqual(
      expect.objectContaining({
        skillId: installed.skillId,
        name: "review-helper",
        enabled: true,
        userInvocable: true,
      }),
    );

    await expect(
      desktopClient.importSkills(workspace.id, {
        target: "CURRENT_PROJECT",
        files: [
          { relativePath: "SKILL.md", file: new Blob(["---\nname: invalid name\n---\ninvalid"]) },
        ],
      }),
    ).rejects.toBeInstanceOf(CaelushClientHttpError);
    const afterFailedReplacement = await webClient.listManagedSkills(workspace.id);
    expect(afterFailedReplacement.items).toEqual(beforeFailedReplacement.items);

    const manualOnly = await webClient.updateSkillSettings(workspace.id, installed.skillId, {
      enabled: true,
      modelInvocable: false,
      expectedCatalogRevision: afterFailedReplacement.catalogRevision,
    });
    expect(manualOnly.settings).toMatchObject({ enabled: true, modelInvocable: false });
    const picker = await desktopClient.listSkills(workspace.id, { q: "review-helper" });
    expect(picker.items).toMatchObject([
      expect.objectContaining({
        skillId: installed.skillId,
        userInvocable: true,
        modelInvocable: false,
      }),
    ]);
    const security = await webClient.getSecurityCapabilities();
    let workspaceSecurity = await webClient.getWorkspaceSecurityCapabilities(workspace.id);
    const preparationRequired = workspaceSecurity.presets.find(
      (preset) => preset.status === "PREPARATION_REQUIRED",
    );
    if (preparationRequired !== undefined) {
      await webClient.prepareWorkspaceSecurity(workspace.id, {
        id: preparationRequired.id,
        expectedVersion: preparationRequired.version,
      });
      workspaceSecurity = await webClient.getWorkspaceSecurityCapabilities(workspace.id);
    }
    const available = workspaceSecurity.presets.find((preset) => preset.status === "AVAILABLE");
    if (available === undefined) throw new Error("no Workspace security preset is available");
    const descriptor = security.presets.find(({ id }) => id === available.id);
    if (descriptor === undefined) throw new Error("the available security preset is not described");
    const skillRun = await webClient.createRun(session.id, {
      goal: "Review the current change",
      submissionId: SubmissionIdSchema.parse(randomUUID()),
      skillSelections: [
        { skillId: picker.items[0]!.skillId, selectionToken: picker.items[0]!.selectionToken },
      ],
      workspace,
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      preset: { id: descriptor.id, expectedVersion: descriptor.version },
      limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 10_000 },
    });
    const preparation = await webClient.getSubmissionSkillPreparation(session.id, skillRun.id);
    expect(preparation).toMatchObject({
      runId: skillRun.id,
      preparationStatus: "CONTENT_READY",
      selectedSkills: [{ skillId: installed.skillId, name: "review-helper" }],
    });
    const pendingPresentation = await webClient.getSessionTurnPresentationCompatible(session.id, {
      runId: skillRun.id,
      limit: 10,
    });
    if (pendingPresentation.capabilityVersion !== 4) {
      throw new Error("the daemon did not return V4 Skill presentation facts");
    }
    expect(pendingPresentation.turns[0]?.items).toContainEqual(
      expect.objectContaining({
        kind: "SKILL",
        skillId: installed.skillId,
        skillStatus: "CONTENT_READY",
      }),
    );
    expect(fixtureProviderCalls).toBe(0);

    await desktopClient.startRun(skillRun.id);
    let settled = await desktopClient.getRun(skillRun.id);
    for (let attempt = 0; attempt < 80 && !isTerminalRunStatus(settled.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await desktopClient.getRun(skillRun.id);
    }
    expect(settled.status).toBe("COMPLETED");
    expect(fixtureProviderCalls).toBe(1);
    const loadedPresentation = await webClient.getSessionTurnPresentationCompatible(session.id, {
      runId: skillRun.id,
      limit: 10,
    });
    if (loadedPresentation.capabilityVersion !== 4) {
      throw new Error("the daemon did not return V4 Skill presentation facts");
    }
    expect(loadedPresentation.turns[0]?.items).toContainEqual(
      expect.objectContaining({
        kind: "SKILL",
        skillId: installed.skillId,
        skillStatus: "LOADED",
      }),
    );
    expect(JSON.stringify(loadedPresentation)).not.toContain("private body");

    await webClient.updateSkillSettings(workspace.id, installed.skillId, {
      enabled: false,
      expectedCatalogRevision: manualOnly.catalogRevision,
    });
    await expect(desktopClient.listManagedSkills(workspace.id)).resolves.toMatchObject({
      items: [expect.objectContaining({ skillId: installed.skillId, enabled: false })],
    });
  });
});
