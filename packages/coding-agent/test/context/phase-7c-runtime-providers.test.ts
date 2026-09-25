import { describe, expect, it } from "vitest";

import {
  CODING_CONTEXT_SOURCE_IDS,
  createGitStateContextSourceProvider,
  createRelevantFileContextSourceProvider,
  createSkillCatalogContextSourceProvider,
  createTemporalContextSourceProvider,
  createVerificationRepairContextSourceProvider,
  type RelevantFileProjection,
} from "@caelush/coding-agent";
import type { ContextSourceInput } from "@caelush/agent";

const sourceInput = {
  identity: {
    runId: "run_1" as never,
    sessionId: "session_1" as never,
    goal: "repair the project",
  },
  turn: { stepId: "step_1" as never, sequence: 1 },
  conversation: {} as never,
  input: { kind: "CONTINUATION", reason: "VERIFICATION_REPAIR" },
  model: {} as never,
  mode: "FORCED_RECOVERY",
  policy: {} as never,
  signal: new AbortController().signal,
} as unknown as ContextSourceInput;

describe("Phase 7C Coding runtime/context providers", () => {
  it("maps already-bounded relevant file sections as retrievable references", async () => {
    const projection: RelevantFileProjection = {
      sections: [
        {
          relativePath: "src/index.ts",
          sourceRef: "project/src/index.ts",
          version: "file-v5",
          content: "export const answer = 42;",
          tokenEstimate: 128,
          bytesIncluded: 25,
          truncated: false,
        },
      ],
    };
    const provider = createRelevantFileContextSourceProvider({
      port: {
        async load() {
          return projection;
        },
      },
    });

    const result = await provider.collect(sourceInput);

    expect(result.items).toMatchObject([
      {
        id: "coding.relevant-files:src/index.ts",
        type: "coding.relevant_file",
        scope: "PROJECT",
        retention: "RETRIEVABLE",
        priorityClass: "NORMAL",
        payload: { kind: "TEXT", text: "export const answer = 42;" },
      },
    ]);
    expect(result.items[0]!.source.sourceRef).toBe("project/src/index.ts");
  });

  it("fails closed when the upstream relevant-file limits are violated", async () => {
    const baseSection = {
      relativePath: "src/file.ts",
      sourceRef: "project/src/file.ts",
      version: "file-v1",
      content: "const value = 1;",
      tokenEstimate: 128,
      bytesIncluded: 16,
      truncated: false,
    };
    const provider = createRelevantFileContextSourceProvider({
      port: {
        async load() {
          return {
            sections: Array.from({ length: 13 }, (_, index) => ({
              ...baseSection,
              relativePath: `src/file-${index}.ts`,
              sourceRef: `project/src/file-${index}.ts`,
            })),
          };
        },
      },
    });

    await expect(provider.collect(sourceInput)).rejects.toThrow(/12 file/i);
  });

  it("provides a real NoOp Skill Catalog and projects only opaque entry metadata", async () => {
    const noOp = createSkillCatalogContextSourceProvider();
    expect((await noOp.collect(sourceInput)).items).toEqual([]);

    const provider = createSkillCatalogContextSourceProvider({
      projectId: "project_1",
      port: {
        async list() {
          return [
            {
              name: "typescript-guidance",
              description: "TypeScript conventions",
              resourceRef: "skill://catalog/typescript-guidance",
              version: "1",
            },
          ];
        },
      },
    });
    const result = await provider.collect(sourceInput);

    expect(result.items).toMatchObject([
      {
        id: "coding.skill-catalog:typescript-guidance:1",
        type: "coding.skill_catalog",
        retention: "RETRIEVABLE",
        priorityClass: "LOW",
        payload: {
          kind: "TEXT",
          text: expect.stringContaining('"resourceRef":"skill://catalog/typescript-guidance"'),
        },
      },
    ]);
  });

  it("projects bounded Git branch and changed-path facts without spawning Git", async () => {
    const provider = createGitStateContextSourceProvider({
      port: {
        async read() {
          return {
            sourceRef: "git:workspace_1",
            version: "git-v2",
            branch: "main",
            changedPaths: ["packages/agent/src/index.ts"],
            summary: "1 modified path",
          };
        },
      },
    });
    const result = await provider.collect(sourceInput);

    expect(result.items).toMatchObject([
      {
        type: "coding.git_state",
        scope: "PROJECT",
        retention: "RETRIEVABLE",
        payload: { kind: "TEXT", text: expect.stringContaining('"branch":"main"') },
      },
    ]);
  });

  it("emits bounded verification repair diagnostics only when supplied", async () => {
    const empty = createVerificationRepairContextSourceProvider();
    expect((await empty.collect(sourceInput)).items).toEqual([]);

    const provider = createVerificationRepairContextSourceProvider({
      port: {
        async read() {
          return {
            repairRef: "repair_1",
            sourceRef: "verification:repair_1",
            version: "repair-v1",
            text: "Diagnostic evidence: the check failed.",
          };
        },
      },
    });
    const result = await provider.collect(sourceInput);

    expect(result.items).toMatchObject([
      {
        id: "coding.verification-repair:repair_1",
        type: "coding.verification_repair",
        scope: "TURN",
        retention: "EPHEMERAL",
        cacheStability: "DYNAMIC",
        payload: { kind: "TEXT", text: "Diagnostic evidence: the check failed." },
      },
    ]);
  });

  it("is deterministic for the same injected clock and changes only with the clock", async () => {
    let now = 1_700_000_000_000;
    const provider = createTemporalContextSourceProvider({ clock: { now: () => now } });

    const one = await provider.collect(sourceInput);
    const two = await provider.collect(sourceInput);
    expect(one.items).toEqual(two.items);
    expect(one.providerVersion).toBe(two.providerVersion);

    now += 86_400_000;
    const next = await provider.collect(sourceInput);
    expect(next.items).not.toEqual(one.items);
    expect(next.items[0]!.source.providerId).toBe(CODING_CONTEXT_SOURCE_IDS.temporal);
  });
});
