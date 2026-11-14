import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

describe("immutable Skill bundle store", () => {
  it("keeps the captured body and resources stable after the source changes", async () => {
    const fixture = await makeFixture("skills-bundle-stable-");
    const store = makeStore(fixture);
    const reference = await store.capture({
      skillId: fixture.candidate.skillId,
      expectedRevision: fixture.candidate.bundleRevision,
      signal: new AbortController().signal,
    });

    await writeSkill(fixture.sourceDirectory, "updated body", "updated resource");
    expect(
      await store.read({
        bundle: reference,
        relativePath: "SKILL.md",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      kind: "TEXT",
      text: expect.stringContaining("original body"),
      complete: true,
    });
    expect(
      await store.read({
        bundle: reference,
        relativePath: "references/guide.md",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      kind: "TEXT",
      text: "original resource",
      complete: true,
    });
  });

  it("rejects a source that changes while its files are copied", async () => {
    const fixture = await makeFixture("skills-bundle-source-change-");
    const createStore = exportedFunction("createFilesystemSkillBundleStore");
    const store = createStore({
      rootDirectory: fixture.storeDirectory,
      resolveSource: async (skillId: string) =>
        skillId === fixture.candidate.skillId ? fixture.source : null,
      beforeSourceStabilityCheck: async (relativePath: string) => {
        if (relativePath === "SKILL.md")
          await writeSkill(fixture.sourceDirectory, "changed during copy", "original resource");
      },
    }) as BundleStore;

    await expect(
      store.capture({
        skillId: fixture.candidate.skillId,
        expectedRevision: fixture.candidate.bundleRevision,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_SOURCE_CHANGED" });
    expect(await listBundleDirectories(fixture.storeDirectory)).toEqual([]);
  });

  it("rejects escaped resource links and corrupted published content", async () => {
    const fixture = await makeFixture("skills-bundle-integrity-");
    const escaped = path.join(fixture.directory, "outside");
    await mkdir(escaped, { recursive: true });
    await writeFile(path.join(escaped, "secret.txt"), "must never be captured");
    await symlink(escaped, path.join(fixture.sourceDirectory, "assets", "escape"), "junction");
    const store = makeStore(fixture);

    await expect(
      store.capture({
        skillId: fixture.candidate.skillId,
        expectedRevision: fixture.candidate.bundleRevision,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    expect(await listBundleDirectories(fixture.storeDirectory)).toEqual([]);

    await rm(path.join(fixture.sourceDirectory, "assets", "escape"), {
      recursive: true,
      force: true,
    });
    const reference = await store.capture({
      skillId: fixture.candidate.skillId,
      expectedRevision: fixture.candidate.bundleRevision,
      signal: new AbortController().signal,
    });
    const unlistedFile = path.join(
      fixture.storeDirectory,
      "bundles",
      reference.bundleRevision.slice("sha256:".length),
      "references",
      "unlisted.txt",
    );
    await writeFile(unlistedFile, "not present in the immutable manifest");
    await expect(
      store.read({
        bundle: reference,
        relativePath: "SKILL.md",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_ARTIFACT_INVALID" });
    await rm(unlistedFile);
    const blobPath = path.join(
      fixture.storeDirectory,
      "bundles",
      reference.bundleRevision.slice("sha256:".length),
      "SKILL.md",
    );
    await writeFile(blobPath, "corrupted after publication");
    await expect(
      store.read({
        bundle: reference,
        relativePath: "SKILL.md",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_ARTIFACT_INVALID" });
  });

  it("deduplicates bytes while keeping references distinct across source scopes", async () => {
    const fixture = await makeFixture("skills-bundle-scopes-");
    const provider = fixture.provider as FilesystemProvider;
    await writeSkill(fixture.projectDirectory, "original body", "original resource");
    const scan = await provider.discover({
      workspaceId: fixture.workspaceId,
      signal: new AbortController().signal,
    });
    const projectCandidate = scan.candidates.find((candidate) => candidate.scopeRank === 0);
    expect(projectCandidate).toBeDefined();
    const projectLocator = await provider.resolveLocator(
      projectCandidate!.privateLocator,
      fixture.workspaceId,
    );
    expect(projectLocator).not.toBeNull();
    const references = new Map([
      [fixture.candidate.skillId, fixture.source],
      [
        projectCandidate!.skillId,
        {
          candidate: projectCandidate!,
          scopeId: `PROJECT:${fixture.workspaceId}`,
          rootDirectory: projectLocator!.rootDirectory,
          packageDirectory: projectLocator!.packageDirectory,
        },
      ],
    ]);
    const createStore = exportedFunction("createFilesystemSkillBundleStore");
    const store = createStore({
      rootDirectory: fixture.storeDirectory,
      resolveSource: async (skillId: string) => references.get(skillId) ?? null,
    }) as BundleStore;
    const userReference = await store.capture({
      skillId: fixture.candidate.skillId,
      signal: new AbortController().signal,
    });
    const projectReference = await store.capture({
      skillId: projectCandidate!.skillId,
      signal: new AbortController().signal,
    });

    expect(projectReference.bundleRevision).toBe(userReference.bundleRevision);
    expect(projectReference.artifactRef).not.toBe(userReference.artifactRef);
    expect(await listBundleDirectories(fixture.storeDirectory)).toHaveLength(1);
  });
});

interface BundleStore {
  capture(input: {
    skillId: string;
    expectedRevision?: string;
    signal: AbortSignal;
  }): Promise<BundleReference>;
  read(input: {
    bundle: BundleReference;
    relativePath: string;
    signal: AbortSignal;
  }): Promise<Record<string, unknown>>;
  releasePreparingReference(artifactRef: string): void;
  collectGarbage(): Promise<unknown>;
}

interface BundleReference {
  readonly bundleRevision: string;
  readonly artifactRef: string;
  readonly manifestFingerprint: string;
}

interface Candidate {
  readonly skillId: string;
  readonly bundleRevision?: string;
  readonly privateLocator: string;
  readonly scopeRank: number;
}

interface FilesystemProvider {
  discover(input: {
    workspaceId: string;
    signal: AbortSignal;
  }): Promise<{ candidates: Candidate[] }>;
  resolveLocator(
    locator: string,
    workspaceId?: string,
  ): Promise<{
    kind: string;
    workspaceId?: string;
    rootDirectory: string;
    packageDirectory: string;
  } | null>;
}

interface Fixture {
  readonly directory: string;
  readonly sourceDirectory: string;
  readonly projectDirectory: string;
  readonly storeDirectory: string;
  readonly workspaceId: string;
  readonly provider: FilesystemProvider;
  readonly candidate: Candidate;
  readonly source: {
    readonly candidate: Candidate;
    readonly scopeId: string;
    readonly rootDirectory: string;
    readonly packageDirectory: string;
  };
}

async function makeFixture(prefix: string): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  const sourceDirectory = path.join(directory, "user", "bundle-skill");
  const projectDirectory = path.join(directory, "workspace", ".agents", "skills", "bundle-skill");
  const storeDirectory = path.join(directory, "store");
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(storeDirectory, { recursive: true }),
  ]);
  await writeSkill(sourceDirectory, "original body", "original resource");
  const createProvider = exportedFunction("createFilesystemSkillProvider");
  const provider = createProvider({
    userRoot: path.dirname(sourceDirectory),
    builtinRoots: [],
    resolveWorkspaceRoot: async () => path.join(directory, "workspace"),
  }) as FilesystemProvider;
  const workspaceId = "bundle-workspace";
  const scan = await provider.discover({ workspaceId, signal: new AbortController().signal });
  const candidate = scan.candidates.find((entry) => entry.scopeRank === 1);
  if (candidate === undefined) throw new Error("Test Skill was not discovered.");
  const locator = await provider.resolveLocator(candidate.privateLocator, workspaceId);
  if (locator === null) throw new Error("Test Skill locator did not resolve.");
  return {
    directory,
    sourceDirectory,
    projectDirectory,
    storeDirectory,
    workspaceId,
    provider,
    candidate,
    source: {
      candidate,
      scopeId: "USER",
      rootDirectory: locator.rootDirectory,
      packageDirectory: locator.packageDirectory,
    },
  };
}

async function writeSkill(directory: string, body: string, resource: string): Promise<void> {
  await mkdir(path.join(directory, "references"), { recursive: true });
  await mkdir(path.join(directory, "assets"), { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: bundle-skill\ndescription: bundle fixture\n---\n${body}\n`,
  );
  await writeFile(path.join(directory, "references", "guide.md"), resource);
}

function makeStore(fixture: Fixture): BundleStore {
  const createStore = exportedFunction("createFilesystemSkillBundleStore");
  return createStore({
    rootDirectory: fixture.storeDirectory,
    resolveSource: async (skillId: string) =>
      skillId === fixture.candidate.skillId ? fixture.source : null,
  }) as BundleStore;
}

async function listBundleDirectories(storeDirectory: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return (await readdir(path.join(storeDirectory, "bundles"))).sort();
  } catch {
    return [];
  }
}

function exportedFunction(name: string): (...args: readonly unknown[]) => unknown {
  const candidate = daemon[name];
  expect(candidate, `${name} should be exported`).toBeTypeOf("function");
  return candidate as (...args: readonly unknown[]) => unknown;
}
