import { createHash } from "node:crypto";
import { createRunId, createToolInvocationId, createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import { createRunSkillModelCatalogService } from "../src/skills/run-skill-search.js";
import { createRunSkillOperationsAdapter } from "../src/skills/skill-operations-adapter.js";

const signal = new AbortController().signal;
const workspaceId = createWorkspaceId();
const runId = createRunId();
const CORE = "Complete immutable frontend design instructions.";
const MANIFEST = `---\nname: frontend-design\ndescription: Build responsive frontend pages and interfaces.\n---\n${CORE}`;
const manifestFingerprint = `sha256:${createHash("sha256").update(MANIFEST, "utf8").digest("hex")}`;
const bundle = {
  bundleRevision: `sha256:${"b".repeat(64)}`,
  artifactRef: "skill:frontend_bundle",
  manifestFingerprint,
};
const snapshot = {
  workspaceId,
  catalogRevision: `sha256:${"c".repeat(64)}`,
  artifactRef: "skillcatalog:fixture",
  manifestFingerprint: `sha256:${"f".repeat(64)}`,
  complete: true as const,
  skills: [
    {
      skillId: "skill_frontend",
      name: "frontend-design",
      description: "Build responsive frontend pages and interfaces.",
      enabled: true,
      userInvocable: false,
      modelInvocable: true,
      searchTerms: ["web design", "responsive layout", "优化页面"],
      bundle,
    },
    {
      skillId: "skill_manual",
      name: "manual-helper",
      description: "Only available for explicit user selection.",
      enabled: true,
      userInvocable: true,
      modelInvocable: false,
      searchTerms: [],
      bundle: {
        bundleRevision: `sha256:${"d".repeat(64)}`,
        artifactRef: "skill:manual_bundle",
        manifestFingerprint: `sha256:${"e".repeat(64)}`,
      },
    },
    {
      skillId: "skill_disabled",
      name: "disabled-helper",
      description: "Disabled Skill fixture.",
      enabled: false,
      userInvocable: true,
      modelInvocable: true,
      searchTerms: [],
      bundle: {
        bundleRevision: `sha256:${"1".repeat(64)}`,
        artifactRef: "skill:disabled_bundle",
        manifestFingerprint: `sha256:${"2".repeat(64)}`,
      },
    },
  ],
};
const profile = {
  runId,
  profileVersion: 1 as const,
  workflowRendererVersion: "workflow-resource@1",
  catalogSnapshotRef: {
    catalogRevision: snapshot.catalogRevision,
    artifactRef: snapshot.artifactRef,
    manifestFingerprint: snapshot.manifestFingerprint,
  },
};

function fingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

describe("Run-bound Skill Tool operations adapter", () => {
  function setup(
    input: {
      readonly resourceOverrides?: Record<string, unknown>;
      readonly rendererVersion?: string;
      readonly coreBody?: string;
    } = {},
  ) {
    const resourceOverrides = input.resourceOverrides ?? {};
    const manifest = `---\nname: frontend-design\ndescription: Build responsive frontend pages and interfaces.\n---\n${input.coreBody ?? CORE}`;
    const activeBundle = { ...bundle, manifestFingerprint: fingerprint(manifest) };
    const activeSnapshot = {
      ...snapshot,
      skills: snapshot.skills.map((skill) =>
        skill.skillId === "skill_frontend" ? { ...skill, bundle: activeBundle } : skill,
      ),
    };
    const reads: string[] = [];
    const bundles = {
      async capture() {
        throw new Error("The automatic read must not capture the live source.");
      },
      async read(input: { readonly relativePath: string }) {
        reads.push(input.relativePath);
        if (input.relativePath !== "SKILL.md") {
          const text = "Complete supplemental reference.";
          return {
            kind: "TEXT" as const,
            relativePath: input.relativePath,
            contentType: "text/markdown",
            fingerprint: fingerprint(text),
            complete: true,
            text,
          };
        }
        return {
          kind: "TEXT" as const,
          relativePath: "SKILL.md",
          contentType: "text/markdown",
          fingerprint: activeBundle.manifestFingerprint,
          complete: true,
          text: manifest,
          ...resourceOverrides,
        };
      },
    };
    const runs = {
      async get() {
        return { workspace: { id: workspaceId } } as never;
      },
      async readWorkflowProfile() {
        return {
          ...profile,
          catalogSnapshotRef: {
            ...profile.catalogSnapshotRef,
            artifactRef: activeSnapshot.artifactRef,
            manifestFingerprint: activeSnapshot.manifestFingerprint,
          },
          ...(input.rendererVersion === undefined
            ? {}
            : { workflowRendererVersion: input.rendererVersion }),
        };
      },
    };
    const snapshots = {
      async readRunSkillCatalogSnapshot() {
        return activeSnapshot;
      },
    };
    const modelCatalog = createRunSkillModelCatalogService({ runs, snapshots });
    const adapter = createRunSkillOperationsAdapter({
      runs,
      snapshots,
      bundles: bundles as never,
      modelCatalog,
    });
    return { adapter, bundles, reads };
  }

  it("searches frozen MODEL metadata and emits a complete core binding without the body", async () => {
    const { adapter } = setup();
    const page = await adapter.search({ runId, query: "优化页面", pageSize: 20, signal });
    expect(page.items.map(({ skillId }) => skillId)).toEqual(["skill_frontend"]);

    const invocationId = createToolInvocationId();
    const result = await adapter.read({ runId, invocationId, skillId: "skill_frontend", signal });
    expect(result.kind).toBe("CORE_CONTENT_READY");
    if (result.kind === "CORE_CONTENT_READY") {
      expect(result.bindingDraft).toMatchObject({
        runId,
        resourceKind: "WORKFLOW_INSTRUCTION",
        resourceId: "skill_frontend",
        resourceRevision: bundle.bundleRevision,
        artifactRef: bundle.artifactRef,
        sourceFingerprint: bundle.manifestFingerprint,
        sourceToolInvocationId: invocationId,
        utf8Bytes: Buffer.byteLength(CORE, "utf8"),
        tokenEstimate: Math.ceil(Buffer.byteLength(CORE, "utf8") / 3),
      });
      expect(JSON.stringify(result.bindingDraft)).not.toContain(CORE);
    }
  });

  it("refuses incomplete or mismatched frozen core content", async () => {
    const { adapter } = setup({ resourceOverrides: { complete: false } });
    await expect(
      adapter.read({
        runId,
        invocationId: createToolInvocationId(),
        skillId: "skill_frontend",
        signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_CORE_INVALID" });
  });

  it("rejects a complete core whose frozen source fingerprint does not match its bytes", async () => {
    const { adapter } = setup({
      resourceOverrides: { fingerprint: `sha256:${"9".repeat(64)}` },
    });
    await expect(
      adapter.read({
        runId,
        invocationId: createToolInvocationId(),
        skillId: "skill_frontend",
        signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_CORE_INVALID" });
  });

  it("rejects an over-budget complete core instead of creating a partial binding", async () => {
    const { adapter } = setup({ coreBody: "x".repeat(49_153) });
    await expect(
      adapter.read({
        runId,
        invocationId: createToolInvocationId(),
        skillId: "skill_frontend",
        signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_CORE_BUDGET_EXCEEDED" });
  });

  it("refuses to auto-read manual-only or disabled skills", async () => {
    const { adapter } = setup();
    await expect(
      adapter.read({
        runId,
        invocationId: createToolInvocationId(),
        skillId: "skill_manual",
        signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_MODEL_INVOCABLE" });
    await expect(
      adapter.read({
        runId,
        invocationId: createToolInvocationId(),
        skillId: "skill_disabled",
        signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_DISABLED" });
    await expect(
      adapter.read({ runId, invocationId: createToolInvocationId(), skillId: "missing", signal }),
    ).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("rejects a core when the frozen renderer is unsupported", async () => {
    const { adapter } = setup({ rendererVersion: "workflow-resource@999" });
    await expect(
      adapter.read({
        runId,
        invocationId: createToolInvocationId(),
        skillId: "skill_frontend",
        signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_CORE_INVALID" });
  });

  it("contains supplementary reads in the bundle and never creates a core binding", async () => {
    const { adapter, reads } = setup();
    await expect(
      adapter.read({
        runId,
        invocationId: createToolInvocationId(),
        skillId: "skill_frontend",
        resourcePath: "../../workspace/private.md",
        signal,
      }),
    ).rejects.toMatchObject({ code: "SKILL_RESOURCE_DENIED" });
    expect(reads).toEqual([]);

    const supplemental = await adapter.read({
      runId,
      invocationId: createToolInvocationId(),
      skillId: "skill_frontend",
      resourcePath: "references/guide.md",
      signal,
    });
    expect(reads).toEqual(["references/guide.md"]);
    expect(supplemental).toMatchObject({
      kind: "SUPPLEMENTAL_RESOURCE",
      resource: { kind: "TEXT", complete: true, text: "Complete supplemental reference." },
    });
    expect(supplemental).not.toHaveProperty("bindingDraft");
  });
});
