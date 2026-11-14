import { createRunId, createWorkspaceId, type SkillSelectionV1 } from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { SkillServiceError } from "../src/skills/feature-policy.js";
import { createSelectedSkillPreparer } from "../src/skills/selected-skill-preparer.js";

const workspaceId = createWorkspaceId();
const runId = createRunId();
const token = "A".repeat(43);
const manifest = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} instructions\nuser-invocable: true\n---\n${body}`;

function makePreparer(
  options: {
    readonly failReadFor?: string;
    readonly coreBody?: string;
    readonly maxActiveCoreUtf8Bytes?: number;
  } = {},
) {
  const targets = new Map([
    [
      "skill:one",
      {
        skillId: "skill:one",
        name: "same-name",
        catalogRevision: "catalog-1",
        bundleRevision: "sha256:one",
      },
    ],
    [
      "skill:two",
      {
        skillId: "skill:two",
        name: "same-name",
        catalogRevision: "catalog-1",
        bundleRevision: "sha256:two",
      },
    ],
  ]);
  const catalog = {
    resolveUserSelections: vi.fn(
      async ({ selections }: { readonly selections: readonly { readonly skillId: string }[] }) =>
        selections.map(({ skillId }) => targets.get(skillId)!),
    ),
  };
  const bundleStore = {
    capture: vi.fn(async ({ skillId }: { skillId: string }) => ({
      bundleRevision: `sha256:${skillId.slice("skill:".length)}`,
      artifactRef: `skill:${skillId.replace(":", "_")}`,
      manifestFingerprint: `sha256:${skillId.slice("skill:".length)}`,
    })),
    read: vi.fn(async ({ bundle }: { bundle: { artifactRef: string } }) => {
      const skillId = bundle.artifactRef.replace("skill:", "").replace("_", ":");
      if (skillId === options.failReadFor) throw new Error("private path must not escape");
      return {
        kind: "TEXT" as const,
        relativePath: "SKILL.md",
        contentType: "text/markdown",
        fingerprint: `sha256:${skillId}`,
        complete: true,
        text: manifest("same-name", options.coreBody ?? `body-${skillId}`),
      };
    }),
  };
  const captureCatalogSnapshot = vi.fn(async () => ({
    catalogRevision: "catalog-1",
    artifactRef: "workflow:snapshot-1",
    manifestFingerprint: "sha256:snapshot",
  }));
  const preparer = createSelectedSkillPreparer({
    catalog: catalog as never,
    bundleStore: bundleStore as never,
    captureCatalogSnapshot,
    ...(options.maxActiveCoreUtf8Bytes === undefined
      ? {}
      : { maxActiveCoreUtf8Bytes: options.maxActiveCoreUtf8Bytes }),
  });
  return { preparer, catalog, bundleStore, captureCatalogSnapshot };
}

function selection(skillId: string): SkillSelectionV1 {
  return { skillId, selectionToken: token };
}

describe("SelectedSkillPreparer", () => {
  it("deduplicates repeated identities while preserving distinct same-name selections in order", async () => {
    const { preparer, bundleStore, captureCatalogSnapshot } = makePreparer();
    const prepared = await preparer.prepare({
      runId,
      workspaceId,
      selections: [selection("skill:one"), selection("skill:one"), selection("skill:two")],
      model: { provider: "test", model: "test-model" },
      signal: new AbortController().signal,
    });

    expect(bundleStore.capture.mock.calls.map(([input]) => input.skillId)).toEqual([
      "skill:one",
      "skill:two",
    ]);
    expect(prepared.bindingsInSelectionOrder.map(({ resourceId }) => resourceId)).toEqual([
      "skill:one",
      "skill:two",
    ]);
    expect(prepared.selectionDisplaySnapshot).toEqual([
      { skillId: "skill:one", name: "same-name" },
      { skillId: "skill:two", name: "same-name" },
    ]);
    expect(prepared.workflowProfile.catalogSnapshotRef.artifactRef).toBe("workflow:snapshot-1");
    expect(captureCatalogSnapshot).toHaveBeenCalledTimes(1);
  });

  it("fails the whole selection when one selected core cannot be read", async () => {
    const { preparer } = makePreparer({ failReadFor: "skill:two" });

    await expect(
      preparer.prepare({
        runId,
        workspaceId,
        selections: [selection("skill:one"), selection("skill:two")],
        model: { provider: "test", model: "test-model" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<Partial<SkillServiceError>>({ reason: "SKILL_LOAD_FAILED" });
  });

  it("captures a directory snapshot for an enabled Run with no manual selections", async () => {
    const { preparer, bundleStore, captureCatalogSnapshot } = makePreparer();
    const prepared = await preparer.prepare({
      runId,
      workspaceId,
      selections: [],
      model: { provider: "test", model: "test-model" },
      signal: new AbortController().signal,
    });

    expect(prepared.bindingsInSelectionOrder).toEqual([]);
    expect(bundleStore.capture).not.toHaveBeenCalled();
    expect(captureCatalogSnapshot).toHaveBeenCalledOnce();
  });

  it("rejects an individual core over 64 KiB and a selection set over its active byte budget", async () => {
    const oversized = makePreparer({ coreBody: "x".repeat(64 * 1024 + 1) });
    await expect(
      oversized.preparer.prepare({
        runId,
        workspaceId,
        selections: [selection("skill:one")],
        model: { provider: "test", model: "test-model" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<Partial<SkillServiceError>>({ reason: "SKILL_CORE_BUDGET_EXCEEDED" });

    const overActiveBudget = makePreparer({
      coreBody: "x".repeat(40 * 1024),
      maxActiveCoreUtf8Bytes: 64 * 1024,
    });
    await expect(
      overActiveBudget.preparer.prepare({
        runId,
        workspaceId,
        selections: [selection("skill:one"), selection("skill:two")],
        model: { provider: "test", model: "test-model" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<Partial<SkillServiceError>>({ reason: "SKILL_CORE_BUDGET_EXCEEDED" });
  });
});
