import { createWorkspaceId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../src/context-builder.js";
import { projectContextContributions } from "../src/context-contribution.js";
import type { ProjectIntelligenceSnapshot } from "../src/snapshot.js";

function snapshot(): ProjectIntelligenceSnapshot {
  const root = "/repo";
  const workspace = { id: createWorkspaceId(), path: root };
  return {
    workspace: { workspace, logicalRoot: root, realRoot: root, cwd: root, realCwd: root },
    projectRoot: { projectRoot: root, reason: "CWD_FALLBACK" },
    environment: {
      platform: "linux",
      arch: "x64",
      hostNodeVersion: "v24.0.0",
      pathStyle: "POSIX",
      workspaceRoot: root,
      projectRoot: root,
      cwd: root,
    },
    profile: {
      ecosystems: [],
      languageSignals: [],
      manifestEvidence: [],
      packageManager: { name: "UNKNOWN", evidencePaths: [] },
      tooling: [],
      isMonorepo: false,
      monorepoEvidence: [],
    },
    instructions: { entries: [], totalBytes: 0, maxBytes: 0 },
    diagnostics: [],
  };
}

describe("Context contribution boundary", () => {
  it("maps priority, provenance, replay retention, redaction, and remeasured tokens", () => {
    const items = projectContextContributions(
      [
        {
          id: "facts",
          source: "local-facts",
          replay: "SNAPSHOT",
          items: [
            {
              id: "fact",
              priorityClass: "OPTIONAL",
              tokenEstimate: 0,
              content: "TOKEN=CAELUSH_CONTEXT_SECRET_9D /home/han/project",
            },
          ],
        },
      ],
      { runId: "run-1", sequence: 2 },
    );

    expect(items[0]).toMatchObject({
      type: "CONTRIBUTION",
      scope: "RUN",
      retention: "REHYDRATABLE",
      priorityClass: "LOW",
      cacheStability: "STABLE",
    });
    expect(items[0]?.content).not.toContain("CAELUSH_CONTEXT_SECRET_9D");
    expect(items[0]?.content).not.toContain("/home/han/project");
    expect(items[0]?.tokenEstimate).toBeGreaterThan(0);
    expect(items[0]?.sourceRef).toContain("run-1");
  });

  it("places the contribution block inside the measured system budget", () => {
    const builder = new ContextBuilder();
    const baseline = builder.build({
      baseSystemPrompt: "base",
      snapshot: snapshot(),
      currentUserMessage: { role: "user", content: "hello" },
      limits: { maxInputTokens: 10_000, safetyMarginTokens: 0 },
    });
    const items = projectContextContributions(
      [
        {
          id: "large",
          source: "test",
          replay: "SNAPSHOT",
          items: [
            { id: "item", priorityClass: "NORMAL", tokenEstimate: 0, content: "x".repeat(500) },
          ],
        },
      ],
      { runId: "run-1", sequence: 1 },
    );
    expect(() =>
      builder.build({
        baseSystemPrompt: "base",
        snapshot: snapshot(),
        currentUserMessage: { role: "user", content: "hello" },
        contextContributionItems: items,
        limits: {
          maxInputTokens: baseline.report.estimatedInputTokens + 1,
          safetyMarginTokens: 0,
        },
      }),
    ).toThrow();
  });
});
