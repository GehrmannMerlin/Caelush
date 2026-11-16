import { createRunId, createWorkspaceId } from "@caelush/protocol";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFilesystemSkillBundleStore } from "../src/skills/bundle-store.js";
import { createSkillCatalogService } from "../src/skills/catalog-service.js";
import { createFilesystemSkillProvider } from "../src/skills/filesystem-provider.js";
import { createRunSkillCatalogSnapshotService } from "../src/skills/run-catalog-snapshot.js";
import { createRunSkillModelCatalogService } from "../src/skills/run-skill-search.js";

const workspaceId = createWorkspaceId();
const signal = new AbortController().signal;
let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Run-bound MODEL Skill catalog", () => {
  it("searches only enabled model Skills from the immutable Run snapshot and binds cursors to Run", async () => {
    const fixture = await createFixture();
    const runOne = createRunId();
    const runTwo = createRunId();
    const snapshot = await fixture.snapshots.captureRunSkillCatalog({
      runId: runOne,
      workspaceId,
      signal,
    });
    const profiles = new Map([
      [runOne, workflowProfile(runOne, snapshot)],
      [runTwo, workflowProfile(runTwo, snapshot)],
    ]);
    const service = createRunSkillModelCatalogService({
      runs: {
        async get() {
          return { workspace: { id: workspaceId } } as never;
        },
        async readWorkflowProfile(runId: string) {
          return profiles.get(runId as typeof runOne) ?? null;
        },
      },
      snapshots: fixture.snapshots,
    });

    const catalog = await service.list({ runId: runOne, signal });
    const localized = await service.search({
      runId: runOne,
      query: "优化页面",
      pageSize: 20,
      signal,
    });
    const manual = await service.search({
      runId: runOne,
      query: "manual helper",
      pageSize: 20,
      signal,
    });
    const disabled = await service.search({
      runId: runOne,
      query: "disabled helper",
      pageSize: 20,
      signal,
    });
    const first = await service.search({
      runId: runOne,
      query: "",
      pageSize: 1,
      signal,
    });

    expect(catalog.revision).toBe(snapshot.catalogRevision);
    expect(catalog.entries.map(({ name }) => name)).toEqual([
      "database-migration",
      "disabled-helper",
      "frontend-design",
      "manual-helper",
    ]);
    expect(localized.items.map(({ name }) => name)).toEqual(["frontend-design"]);
    expect(manual.items).toEqual([]);
    expect(disabled.items).toEqual([]);
    expect(first.nextCursor).toBeTypeOf("string");
    await expect(
      service.search({
        runId: runTwo,
        query: "",
        cursor: first.nextCursor,
        pageSize: 1,
        signal,
      }),
    ).rejects.toThrow();
  });
});

async function createFixture() {
  root = await mkdtemp(join(tmpdir(), "caelush-model-skill-catalog-"));
  const userRoot = join(root, "user-skills");
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, ".agents", "skills"), { recursive: true });
  await writeSkill(userRoot, "frontend-design", {
    description: "Build responsive frontend pages and interfaces.",
    body: "Design responsive interfaces.",
    searchTerms: "web design, landing pages",
  });
  await writeSkill(userRoot, "database-migration", {
    description: "Plan SQL database schema migrations.",
    body: "Plan database migrations.",
  });
  await writeSkill(userRoot, "manual-helper", {
    description: "Manual helper skill for explicit user selection.",
    body: "Only load manually.",
    frontmatter: "user-invocable: true\ndisable-model-invocation: true",
  });
  await writeSkill(userRoot, "disabled-helper", {
    description: "Disabled helper skill.",
    body: "Must not be selected.",
  });

  const provider = createFilesystemSkillProvider({
    userRoot,
    resolveWorkspaceRoot: async () => workspaceRoot,
  });
  const discovered = await provider.discover({ workspaceId, signal });
  const disabled = discovered.candidates.find(
    ({ manifest }) => manifest.name === "disabled-helper",
  );
  if (disabled === undefined) throw new Error("Fixture Skill discovery failed.");
  const catalog = createSkillCatalogService({
    provider,
    settings: {
      async getMany(skillIds) {
        return new Map(
          skillIds.map((skillId) => [
            skillId,
            {
              skillId,
              enabled: skillId !== disabled.skillId,
              version: skillId === disabled.skillId ? 1 : 0,
              updatedAtMs: 0,
            },
          ]),
        );
      },
    },
  });
  const bundleStore = createFilesystemSkillBundleStore({
    rootDirectory: join(root, "bundles"),
    resolveSource: async (skillId, requestedWorkspaceId, candidateOverride) => {
      if (requestedWorkspaceId === undefined) return null;
      const candidate =
        candidateOverride ?? discovered.candidates.find((entry) => entry.skillId === skillId);
      if (candidate === undefined || candidate.skillId !== skillId) return null;
      const locator = await provider.resolveLocator(candidate.privateLocator, requestedWorkspaceId);
      if (locator === null) return null;
      return {
        candidate,
        scopeId: candidate.providerId,
        rootDirectory: locator.rootDirectory,
        packageDirectory: locator.packageDirectory,
      };
    },
  });
  const snapshots = createRunSkillCatalogSnapshotService({
    rootDirectory: join(root, "catalog-snapshots"),
    catalog,
    bundleStore,
  });
  return { snapshots };
}

async function writeSkill(
  rootDirectory: string,
  folder: string,
  input: {
    readonly description: string;
    readonly body: string;
    readonly searchTerms?: string;
    readonly frontmatter?: string;
  },
): Promise<void> {
  const directory = join(rootDirectory, folder);
  await mkdir(directory, { recursive: true });
  const extra = [
    input.frontmatter,
    input.searchTerms === undefined ? undefined : `metadata:\n  searchTerms: ${input.searchTerms}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${folder}\ndescription: ${input.description}\n${extra === "" ? "" : `${extra}\n`}---\n${input.body}`,
    "utf8",
  );
}

function workflowProfile(
  runId: ReturnType<typeof createRunId>,
  snapshot: Awaited<
    ReturnType<ReturnType<typeof createRunSkillCatalogSnapshotService>["captureRunSkillCatalog"]>
  >,
) {
  return {
    runId,
    profileVersion: 1 as const,
    workflowRendererVersion: "workflow-resource@1",
    catalogSnapshotRef: {
      catalogRevision: snapshot.catalogRevision,
      artifactRef: snapshot.artifactRef,
      manifestFingerprint: snapshot.manifestFingerprint,
    },
  };
}
