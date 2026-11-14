import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("Skill bundle quota and garbage collection", () => {
  it("keeps content when no durable reference authority can prove it unreferenced", async () => {
    const fixture = await makeFixture("skills-bundle-gc-no-authority-");
    const createStore = exportedFunction("createFilesystemSkillBundleStore");
    const store = createStore({
      rootDirectory: fixture.storeDirectory,
      resolveSource: async (skillId: string) =>
        skillId === fixture.candidate.skillId ? fixture.source : null,
    }) as BundleStore;
    const reference = await store.capture({
      skillId: fixture.candidate.skillId,
      signal: new AbortController().signal,
    });
    store.releasePreparingReference(reference.artifactRef);

    expect(await store.collectGarbage()).toMatchObject({ removedBundles: 0 });
    expect(
      await store.read({
        bundle: reference,
        relativePath: "SKILL.md",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ kind: "TEXT" });
  });

  it("protects persistent and preparing references, then removes unreferenced bundles", async () => {
    const fixture = await makeFixture("skills-bundle-gc-refs-");
    const persistent = new Set<string>();
    const store = makeStore(fixture, {
      references: {
        isReferenced: async (reference: BundleReference) => persistent.has(reference.artifactRef),
      },
    });
    const reference = await store.capture({
      skillId: fixture.candidate.skillId,
      signal: new AbortController().signal,
    });

    expect(await store.collectGarbage()).toMatchObject({ removedBundles: 0, removedStaging: 0 });
    persistent.add(reference.artifactRef);
    store.releasePreparingReference(reference.artifactRef);
    expect(await store.collectGarbage()).toMatchObject({ removedBundles: 0 });
    expect(
      await store.read({
        bundle: reference,
        relativePath: "SKILL.md",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ kind: "TEXT" });

    persistent.delete(reference.artifactRef);
    expect(await store.collectGarbage()).toMatchObject({ removedBundles: 1 });
    await expect(
      store.read({
        bundle: reference,
        relativePath: "SKILL.md",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_ARTIFACT_INVALID" });
  });

  it("rejects quota overflow without deleting content protected by a Run reference", async () => {
    const fixture = await makeFixture("skills-bundle-gc-quota-");
    const persistent = new Set<string>();
    const createStore = exportedFunction("createFilesystemSkillBundleStore");
    const store = createStore({
      rootDirectory: fixture.storeDirectory,
      quotaBytes: 128,
      resolveSource: async (skillId: string) =>
        skillId === fixture.candidate.skillId ? fixture.source : null,
      references: {
        isReferenced: async (reference: BundleReference) => persistent.has(reference.artifactRef),
      },
    }) as BundleStore;
    const first = await store.capture({
      skillId: fixture.candidate.skillId,
      signal: new AbortController().signal,
    });
    persistent.add(first.artifactRef);
    store.releasePreparingReference(first.artifactRef);
    await writeSkill(fixture.sourceDirectory, "second version that is over quota");
    const secondCandidate = await fixture.provider.discover({
      workspaceId: fixture.workspaceId,
      signal: new AbortController().signal,
    });
    expect(secondCandidate.candidates[0]?.bundleRevision).not.toBe(first.bundleRevision);
    fixture.sourceCandidate = secondCandidate.candidates[0]!;
    fixture.source = { ...fixture.source, candidate: fixture.sourceCandidate };

    await expect(
      store.capture({
        skillId: fixture.sourceCandidate.skillId,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "SKILLS_QUOTA_EXCEEDED" });
    expect(
      await store.read({
        bundle: first,
        relativePath: "SKILL.md",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ kind: "TEXT" });
    expect(await store.collectGarbage()).toMatchObject({ removedBundles: 0 });
  });

  it("removes abandoned staging directories without touching active bundle content", async () => {
    const fixture = await makeFixture("skills-bundle-gc-staging-");
    const store = makeStore(fixture);
    const reference = await store.capture({
      skillId: fixture.candidate.skillId,
      signal: new AbortController().signal,
    });
    await mkdir(path.join(fixture.storeDirectory, "staging", "abandoned"), { recursive: true });
    await writeFile(
      path.join(fixture.storeDirectory, "staging", "abandoned", "partial"),
      "partial",
    );

    expect(await store.collectGarbage()).toMatchObject({ removedStaging: 1 });
    expect(
      await readFile(
        path.join(
          fixture.storeDirectory,
          "bundles",
          reference.bundleRevision.slice("sha256:".length),
          "SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("original body");
  });
});

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

interface Provider {
  discover(input: {
    workspaceId: string;
    signal: AbortSignal;
  }): Promise<{ candidates: Candidate[] }>;
  resolveLocator(
    locator: string,
    workspaceId?: string,
  ): Promise<{ rootDirectory: string; packageDirectory: string } | null>;
}

interface Source {
  readonly candidate: Candidate;
  readonly scopeId: string;
  readonly rootDirectory: string;
  readonly packageDirectory: string;
}

interface Fixture {
  readonly directory: string;
  readonly storeDirectory: string;
  readonly workspaceId: string;
  readonly provider: Provider;
  readonly candidate: Candidate;
  sourceCandidate: Candidate;
  source: Source;
  readonly sourceDirectory: string;
}

interface BundleStore {
  capture(input: { skillId: string; signal: AbortSignal }): Promise<BundleReference>;
  read(input: {
    bundle: BundleReference;
    relativePath: string;
    signal: AbortSignal;
  }): Promise<Record<string, unknown>>;
  releasePreparingReference(artifactRef: string): void;
  collectGarbage(): Promise<{
    removedBundles: number;
    removedStaging: number;
    removedBytes: number;
  }>;
}

async function makeFixture(prefix: string): Promise<Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  const sourceDirectory = path.join(directory, "user", "gc-skill");
  const workspaceId = "gc-workspace";
  await mkdir(sourceDirectory, { recursive: true });
  await writeSkill(sourceDirectory, "original body");
  const providerFactory = exportedFunction("createFilesystemSkillProvider");
  const provider = providerFactory({
    userRoot: path.dirname(sourceDirectory),
    builtinRoots: [],
    resolveWorkspaceRoot: async () => path.join(directory, "workspace"),
  }) as Provider;
  const discovery = await provider.discover({ workspaceId, signal: new AbortController().signal });
  const candidate = discovery.candidates[0];
  if (candidate === undefined) throw new Error("Test Skill was not discovered.");
  const sourceLocation = await provider.resolveLocator(candidate.privateLocator, workspaceId);
  if (sourceLocation === null) throw new Error("Test Skill source did not resolve.");
  return {
    directory,
    sourceDirectory,
    storeDirectory: path.join(directory, "store"),
    workspaceId,
    provider,
    candidate,
    sourceCandidate: candidate,
    source: {
      candidate,
      scopeId: "USER",
      rootDirectory: sourceLocation.rootDirectory,
      packageDirectory: sourceLocation.packageDirectory,
    },
  };
}

async function writeSkill(directory: string, body: string): Promise<void> {
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: gc-skill\ndescription: garbage collector fixture\n---\n${body}\n`,
  );
}

function makeStore(fixture: Fixture, extra: Record<string, unknown> = {}): BundleStore {
  const factory = exportedFunction("createFilesystemSkillBundleStore");
  return factory({
    rootDirectory: fixture.storeDirectory,
    resolveSource: async (skillId: string) =>
      skillId === fixture.sourceCandidate.skillId ? fixture.source : null,
    references: { isReferenced: async () => false },
    ...extra,
  }) as BundleStore;
}

function exportedFunction(name: string): (...args: readonly unknown[]) => unknown {
  const candidate = daemon[name];
  expect(candidate, `${name} should be exported`).toBeTypeOf("function");
  return candidate as (...args: readonly unknown[]) => unknown;
}
