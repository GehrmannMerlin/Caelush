import { createWorkspaceId } from "@caelush/protocol";
import { createSkillIdentity, type SkillCandidate, type SkillProviderPort } from "@caelush/skills";
import { describe, expect, it, vi } from "vitest";
import {
  createSkillCatalogService,
  createSkillSelectionTokenCodec,
  SkillServiceError,
} from "../src/index.js";

const revision = `sha256:${"a".repeat(64)}`;
const workspaceId = createWorkspaceId();
const providerId = `project:${workspaceId}`;
const privateLocator = "private-locator";
const candidate: SkillCandidate = Object.freeze({
  skillId: createSkillIdentity({ scopeRank: 0, providerId, privateLocator }),
  manifest: Object.freeze({
    name: "review-helper",
    description: "Reviews a project",
    body: "",
    userInvocable: true,
    modelInvocable: true,
  }),
  scopeRank: 0,
  providerId,
  privateLocator,
  bundleRevision: revision,
});
const candidate2: SkillCandidate = Object.freeze({
  ...candidate,
  skillId: createSkillIdentity({
    scopeRank: 0,
    providerId,
    privateLocator: "second-private-locator",
  }),
  manifest: Object.freeze({
    ...candidate.manifest,
    name: "writer-helper",
  }),
  privateLocator: "second-private-locator",
});

function makeCatalog() {
  const getMany = vi.fn(async () => new Map());
  const provider: SkillProviderPort = {
    discover: async () => ({
      candidates: [candidate, candidate2],
      diagnostics: [],
      complete: true,
    }),
  };
  return {
    getMany,
    catalog: createSkillCatalogService({
      provider,
      settings: { getMany },
      selectionTokens: createSkillSelectionTokenCodec(new Uint8Array(32).fill(7)),
    }),
  };
}

describe("explicit Skill selection identity", () => {
  it("resolves only the exact workspace, id, catalog revision and selection token", async () => {
    const { catalog, getMany } = makeCatalog();
    const page = await catalog.listUserCatalog({
      workspaceId,
      pageSize: 100,
      signal: new AbortController().signal,
    });
    const item = page.items[0]!;
    getMany.mockClear();

    await expect(
      catalog.resolveUserSelections({
        workspaceId,
        selections: page.items.map(({ skillId, selectionToken }) => ({
          skillId,
          selectionToken,
        })),
        signal: new AbortController().signal,
      }),
    ).resolves.toHaveLength(2);
    expect(getMany).toHaveBeenCalledOnce();

    await expect(
      catalog.resolveUserSelection({
        workspaceId,
        skillId: item.skillId,
        selectionToken: item.selectionToken,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      skillId: item.skillId,
      name: item.name,
      catalogRevision: page.catalogRevision,
      bundleRevision: revision,
    });

    await expect(
      catalog.resolveUserSelection({
        workspaceId: createWorkspaceId(),
        skillId: item.skillId,
        selectionToken: item.selectionToken,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<Partial<SkillServiceError>>({ reason: "SKILL_SELECTION_STALE" });

    await expect(
      catalog.resolveUserSelection({
        workspaceId,
        skillId: item.skillId,
        selectionToken: "A".repeat(43),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<Partial<SkillServiceError>>({ reason: "SKILL_SELECTION_STALE" });
  });
});
