import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const daemon = (await import("../src/index.js")) as unknown as Record<string, unknown>;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded local Skill import", () => {
  it("installs only into the selected project or all-projects root and returns a safe receipt", async () => {
    const fixture = await makeFixture("skills-import-targets-");
    const service = makeImportService(fixture);
    const project = await service.import({
      workspaceId: fixture.workspaceId,
      target: "CURRENT_PROJECT",
      files: filesFor("project version"),
      signal: new AbortController().signal,
    });
    const user = await service.import({
      workspaceId: fixture.workspaceId,
      target: "ALL_PROJECTS",
      files: filesFor("user version"),
      signal: new AbortController().signal,
    });

    expect(project).toMatchObject({
      target: "CURRENT_PROJECT",
      name: "imported-skill",
      replaced: false,
    });
    expect(user).toMatchObject({ target: "ALL_PROJECTS", name: "imported-skill", replaced: false });
    expect(project.skillId).not.toBe(user.skillId);
    expect(
      await readFile(path.join(fixture.workspaceSkills, "imported-skill", "SKILL.md"), "utf8"),
    ).toContain("project version");
    expect(
      await readFile(path.join(fixture.userSkills, "imported-skill", "SKILL.md"), "utf8"),
    ).toContain("user version");
    expect(JSON.stringify([project, user])).not.toContain(fixture.directory);
  });

  it("keeps an old package readable after invalid content and cancellation", async () => {
    const fixture = await makeFixture("skills-import-rollback-");
    const controller = new AbortController();
    let cancelNext = false;
    const service = makeImportService(fixture, {
      afterFileStaged: async (relativePath: string) => {
        if (cancelNext && relativePath === "SKILL.md") controller.abort();
      },
    });
    const first = await service.import({
      workspaceId: fixture.workspaceId,
      target: "CURRENT_PROJECT",
      files: filesFor("old readable version"),
      signal: new AbortController().signal,
    });
    const destination = path.join(fixture.workspaceSkills, "imported-skill");
    const oldManifest = await readFile(path.join(destination, "SKILL.md"), "utf8");
    await expect(
      service.import({
        workspaceId: fixture.workspaceId,
        target: "CURRENT_PROJECT",
        files: [
          {
            relativePath: "SKILL.md",
            bytes: new TextEncoder().encode(
              "---\nname: broken\nname: duplicate\ndescription: bad\n---\n",
            ),
          },
        ],
        expectedRevision: first.bundleRevision,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_IMPORT_INVALID" });
    cancelNext = true;
    await expect(
      service.import({
        workspaceId: fixture.workspaceId,
        target: "CURRENT_PROJECT",
        files: filesFor("cancelled version"),
        expectedRevision: first.bundleRevision,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_IMPORT_CANCELLED" });

    expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe(oldManifest);
    expect(
      await readdir(path.join(fixture.workspaceRoot, ".agents", ".skills-import-staging")),
    ).toEqual([]);
  });

  it("rejects host paths, traversal, non-package files, symlink destinations, and stale revisions", async () => {
    const fixture = await makeFixture("skills-import-containment-");
    const service = makeImportService(fixture);
    const outside = path.join(fixture.directory, "outside.txt");
    await expect(
      service.import({
        workspaceId: fixture.workspaceId,
        target: "CURRENT_PROJECT",
        files: [{ relativePath: "../outside.txt", bytes: new TextEncoder().encode("escape") }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_IMPORT_INVALID" });
    await expect(
      service.import({
        workspaceId: fixture.workspaceId,
        target: "CURRENT_PROJECT",
        files: [
          filesFor("root only")[0]!,
          { relativePath: "references", bytes: new TextEncoder().encode("not a file path") },
        ],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_IMPORT_INVALID" });
    expect(await stat(outside).catch(() => undefined)).toBeUndefined();

    const first = await service.import({
      workspaceId: fixture.workspaceId,
      target: "CURRENT_PROJECT",
      files: filesFor("initial"),
      signal: new AbortController().signal,
    });
    await expect(
      service.import({
        workspaceId: fixture.workspaceId,
        target: "CURRENT_PROJECT",
        files: filesFor("stale update"),
        expectedRevision: "sha256:stale",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_IMPORT_STALE" });
    expect(
      await readFile(path.join(fixture.workspaceSkills, "imported-skill", "SKILL.md"), "utf8"),
    ).toContain("initial");

    await rm(path.join(fixture.workspaceSkills, "imported-skill"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(
      fixture.directory,
      path.join(fixture.workspaceSkills, "imported-skill"),
      "junction",
    );
    await expect(
      service.import({
        workspaceId: fixture.workspaceId,
        target: "CURRENT_PROJECT",
        files: filesFor("must not follow"),
        expectedRevision: first.bundleRevision,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_IMPORT_INVALID" });
  });

  it("enforces the package file, resource, and total-byte limits before publication", async () => {
    const fixture = await makeFixture("skills-import-limits-");
    const service = makeImportService(
      fixture,
      {},
      {
        maxPackageBytes: 128,
        maxPackageFiles: 2,
        maxResourceBytes: 4,
      },
    );
    const base = filesFor("limit test");
    await expect(
      service.import({
        workspaceId: fixture.workspaceId,
        target: "CURRENT_PROJECT",
        files: [...base, { relativePath: "references/extra.md", bytes: new Uint8Array() }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_PACKAGE_FILE_LIMIT" });
    await expect(
      service.import({
        workspaceId: fixture.workspaceId,
        target: "CURRENT_PROJECT",
        files: [
          base[0]!,
          { relativePath: "references/guide.md", bytes: new TextEncoder().encode("12345") },
        ],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_RESOURCE_TOO_LARGE" });
    await expect(stat(path.join(fixture.workspaceSkills, "imported-skill"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

interface ImportService {
  import(input: {
    workspaceId: string;
    target: "CURRENT_PROJECT" | "ALL_PROJECTS" | string;
    files: readonly { relativePath: string; bytes: Uint8Array }[];
    expectedRevision?: string;
    signal: AbortSignal;
  }): Promise<{
    skillId: string;
    name: string;
    target: string;
    bundleRevision: string;
    replaced: boolean;
  }>;
}

interface Fixture {
  readonly directory: string;
  readonly workspaceRoot: string;
  readonly workspaceSkills: string;
  readonly userSkills: string;
  readonly workspaceId: string;
}

async function makeFixture(prefix: string): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  const workspaceRoot = path.join(directory, "workspace");
  const workspaceSkills = path.join(workspaceRoot, ".agents", "skills");
  const userSkills = path.join(directory, "profile", "skills");
  await Promise.all([
    mkdir(workspaceSkills, { recursive: true }),
    mkdir(userSkills, { recursive: true }),
  ]);
  return { directory, workspaceRoot, workspaceSkills, userSkills, workspaceId: "import-workspace" };
}

function makeImportService(
  fixture: Fixture,
  hooks: { readonly afterFileStaged?: (relativePath: string) => void | Promise<void> } = {},
  policy: Readonly<Record<string, number>> = {},
): ImportService {
  const factory = exportedFunction("createSkillImportService");
  return factory({
    userRoot: fixture.userSkills,
    resolveWorkspaceRoot: async (workspaceId: string) => {
      if (workspaceId !== fixture.workspaceId) throw new Error("unknown workspace");
      return fixture.workspaceRoot;
    },
    ...hooks,
    policy,
  }) as ImportService;
}

function filesFor(body: string): readonly { relativePath: string; bytes: Uint8Array }[] {
  return [
    {
      relativePath: "SKILL.md",
      bytes: new TextEncoder().encode(
        `---\nname: imported-skill\ndescription: imported fixture\n---\n${body}\n`,
      ),
    },
    { relativePath: "references/guide.md", bytes: new TextEncoder().encode("safe guide") },
  ];
}

function exportedFunction(name: string): (...args: readonly unknown[]) => unknown {
  const candidate = daemon[name];
  expect(candidate, `${name} should be exported`).toBeTypeOf("function");
  return candidate as (...args: readonly unknown[]) => unknown;
}
