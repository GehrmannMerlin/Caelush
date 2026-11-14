import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDaemonApp,
  createFilesystemSkillProvider,
  createSkillCatalogService,
} from "../src/index.js";
import type { SkillImportErrorCode } from "../src/skills/bundle-import-service.js";
import { SkillImportServiceError } from "../src/skills/bundle-import-service.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

let storage: CaelushStorage | undefined;
let directory: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Skill V1 routes", () => {
  it("serves versioned picker and management pages, applies settings CAS, and rejects stale cursors", async () => {
    const fixture = await makeFixture();
    const workspaceId = fixture.workspaceId;
    await addSkill(fixture.workspaceSkills, "auto-skill", true, true, "project automatic");
    await addSkill(fixture.workspaceSkills, "manual-skill", true, false, "manual only");
    await addSkill(fixture.workspaceSkills, "private-skill", false, false, "not user selectable");
    await addSkill(fixture.userSkills, "auto-skill", true, true, "lower priority duplicate");
    const app = await fixture.makeApp();

    const capabilities = await get(app, "/api/v1/skills/capabilities");
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toEqual({
      schemaVersion: 1,
      enabled: true,
      catalog: true,
      invocation: false,
      scriptExecution: false,
      presentationVersion: null,
    });

    const picker = await get(app, `/api/v1/workspaces/${workspaceId}/skills?pageSize=1`);
    expect(picker.statusCode).toBe(200);
    expect(picker.json().items).toHaveLength(1);
    expect(picker.json().items[0]).toMatchObject({ name: "auto-skill", userInvocable: true });
    expect(JSON.stringify(picker.json())).not.toMatch(/source|root|absolutePath|hostPath/u);
    expect(picker.json().items[0]).toHaveProperty("selectionToken");
    expect(picker.json().nextCursor).toBeTypeOf("string");

    const management = await get(
      app,
      `/api/v1/workspaces/${workspaceId}/skills/management?pageSize=100`,
    );
    expect(management.statusCode).toBe(200);
    expect(
      management
        .json()
        .items.map((item: { name: string }) => item.name)
        .sort(),
    ).toEqual(["auto-skill", "manual-skill", "private-skill"]);
    expect(
      management.json().items.find((item: { name: string }) => item.name === "manual-skill"),
    ).toMatchObject({ userInvocable: true, modelInvocable: false });
    expect(JSON.stringify(management.json())).not.toMatch(
      /selectionToken|privateLocator|source|root|hostPath/u,
    );

    const auto = management
      .json()
      .items.find((item: { name: string }) => item.name === "auto-skill");
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(auto.skillId)}/settings`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { enabled: false, expectedCatalogRevision: management.json().catalogRevision },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().settings).toMatchObject({ skillId: auto.skillId, enabled: false });
    expect(changed.json().catalogRevision).not.toBe(management.json().catalogRevision);

    const staleCursor = await get(
      app,
      `/api/v1/workspaces/${workspaceId}/skills?pageSize=1&cursor=${encodeURIComponent(picker.json().nextCursor)}`,
    );
    expect(staleCursor.statusCode).toBe(409);
    const staleSettings = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/skills/${encodeURIComponent(auto.skillId)}/settings`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { enabled: true, expectedCatalogRevision: management.json().catalogRevision },
    });
    expect(staleSettings.statusCode).toBe(409);

    const unknownWorkspaceId = `${workspaceId.slice(0, -1)}${workspaceId.endsWith("0") ? "1" : "0"}`;
    const denied = await get(app, `/api/v1/workspaces/${unknownWorkspaceId}/skills`);
    expect(denied.statusCode).toBe(404);
    await app.close();
  });

  it("keeps the capability truthful when the master switch is OFF and accepts bounded multipart imports", async () => {
    const fixture = await makeFixture();
    const workspaceId = fixture.workspaceId;
    const app = await fixture.makeApp({ enabled: false });
    const capability = await get(app, "/api/v1/skills/capabilities");
    expect(capability.json()).toMatchObject({
      enabled: false,
      catalog: false,
      invocation: false,
      scriptExecution: false,
    });
    const unavailable = await get(app, `/api/v1/workspaces/${workspaceId}/skills`);
    expect(unavailable.statusCode).toBe(503);
    await app.close();

    const enabledApp = await fixture.makeApp({ enabled: true });
    const imported = await enabledApp.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/skills/import`,
      headers: {
        host: "127.0.0.1",
        "content-type": "multipart/form-data; boundary=skill-boundary",
      },
      payload: multipartSkillImport(),
    });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json()).toMatchObject({
      schemaVersion: 1,
      target: "CURRENT_PROJECT",
      name: "imported-skill",
      replaced: false,
    });
    expect(JSON.stringify(imported.json())).not.toMatch(/source|root|hostPath|absolutePath/u);
    expect(fixture.importedFiles).toHaveLength(1);
    expect(fixture.importedFiles[0]).toMatchObject({ relativePath: "SKILL.md" });
    expect(new TextDecoder().decode(fixture.importedFiles[0]!.bytes)).toContain("imported body");
    await enabledApp.close();
  });

  it("maps invalid imports and containment rejection to safe API errors", async () => {
    const fixture = await makeFixture();
    for (const [code, status] of [
      ["SKILL_IMPORT_INVALID", 422],
      ["SYMLINK_ESCAPE", 403],
    ] as const) {
      const app = await fixture.makeApp({ enabled: true }, code);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${fixture.workspaceId}/skills/import`,
        headers: {
          host: "127.0.0.1",
          "content-type": "multipart/form-data; boundary=skill-boundary",
        },
        payload: multipartSkillImport(),
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.details.reason).toBe(code);
      expect(response.body).not.toMatch(/C:\\\\secret|privateLocator|absolutePath/u);
      await app.close();
    }
  });
});

interface Fixture {
  readonly workspaceSkills: string;
  readonly userSkills: string;
  readonly workspaceId: string;
  readonly importedFiles: Array<{ relativePath: string; bytes: Uint8Array }>;
  makeApp(
    readiness?: { enabled: boolean },
    importFailureCode?: SkillImportErrorCode,
  ): Promise<ReturnType<typeof buildDaemonApp>>;
}

async function makeFixture(): Promise<Fixture> {
  directory = await mkdtemp(join(tmpdir(), "caelush-skills-routes-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  const workspaceRoot = join(directory, "workspace");
  const workspaceSkills = join(workspaceRoot, ".agents", "skills");
  const userSkills = join(directory, "profile", "skills");
  const builtinSkills = join(directory, "builtin-skills");
  await Promise.all([
    mkdir(workspaceSkills, { recursive: true }),
    mkdir(userSkills, { recursive: true }),
    mkdir(builtinSkills, { recursive: true }),
  ]);
  const workspaceService = new WorkspaceService({ repository: storage.workspaces });
  const registered = await workspaceService.registerWorkspace({ path: workspaceRoot });
  const importedFiles: Array<{ relativePath: string; bytes: Uint8Array }> = [];
  return {
    workspaceSkills,
    userSkills,
    workspaceId: registered.workspace.id,
    importedFiles,
    async makeApp(readiness = { enabled: true }, importFailureCode?: SkillImportErrorCode) {
      const provider = createFilesystemSkillProvider({
        userRoot: userSkills,
        builtinRoots: [builtinSkills],
        resolveWorkspaceRoot: async (workspaceId) =>
          (await workspaceService.requireWorkspace(workspaceId as never)).canonicalPath,
      });
      const catalog = createSkillCatalogService({ provider, settings: storage!.skillSettings });
      const importService = {
        async import(input: {
          files: readonly { relativePath: string; bytes: Uint8Array }[];
          target: string;
        }) {
          if (importFailureCode !== undefined) throw new SkillImportServiceError(importFailureCode);
          importedFiles.splice(0, importedFiles.length, ...input.files);
          return {
            skillId: "skill:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            name: "imported-skill",
            target: input.target,
            bundleRevision: `sha256:${"b".repeat(64)}`,
            replaced: false,
          };
        },
      };
      return buildDaemonApp({
        sessions: storage!.sessions,
        runs: storage!.runs,
        workspaces: storage!.workspaces,
        workspaceService,
        skillCatalog: catalog,
        skillSettings: storage!.skillSettings,
        skillImportService: importService as never,
        skillFeatureReadiness: {
          enabled: readiness.enabled,
          catalogReady: true,
          invocationReady: false,
          scriptExecutionReady: false,
          presentationReady: false,
        },
        watchSkillWorkspace: vi.fn(async () => undefined),
        eventHub: { watch: async function* () {} } as never,
        config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
      });
    },
  };
}

async function addSkill(
  root: string,
  name: string,
  userInvocable: boolean,
  modelInvocable: boolean,
  body: string,
): Promise<void> {
  const skillDirectory = join(root, name);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture\nuser-invocable: ${userInvocable}\ndisable-model-invocation: ${!modelInvocable}\n---\n${body}\n`,
  );
}

async function get(app: ReturnType<typeof buildDaemonApp>, url: string) {
  return app.inject({ method: "GET", url, headers: { host: "127.0.0.1" } });
}

function multipartSkillImport(): string {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    files: [{ field: "file-0", relativePath: "SKILL.md" }],
  });
  return [
    "--skill-boundary",
    'Content-Disposition: form-data; name="target"',
    "",
    "CURRENT_PROJECT",
    "--skill-boundary",
    'Content-Disposition: form-data; name="manifest"',
    "Content-Type: application/json",
    "",
    manifest,
    "--skill-boundary",
    'Content-Disposition: form-data; name="file-0"; filename="upload-0"',
    "Content-Type: application/octet-stream",
    "",
    "---\nname: imported-skill\ndescription: imported fixture\n---\nimported body",
    "--skill-boundary--",
    "",
  ].join("\r\n");
}
