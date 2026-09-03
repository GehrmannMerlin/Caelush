import { describe, expect, it } from "vitest";
import {
  applyWorldStateDelta,
  createWorldStateProjection,
  diffWorldState,
  isGeneratedTreePath,
} from "../src/world-state.js";

const base = createWorldStateProjection({
  revision: "r1",
  workspaceIdentity: "workspace-1",
  projectManifests: ["package.json"],
  languageFramework: ["TypeScript"],
  projectRules: ["read AGENTS.md"],
  changedFiles: [],
  gitSummary: "clean",
  activeProcesses: [],
  approvalSummary: "none",
  verificationSummary: "pending",
  resourceGovernance: "active",
  recentImportantFacts: [],
});

describe("WorldStateProjection", () => {
  it("creates a bounded snapshot and applies only revision deltas", () => {
    const next = createWorldStateProjection({
      ...base,
      revision: "r2",
      changedFiles: ["src/index.ts"],
      gitSummary: "modified",
    });
    const delta = diffWorldState(base, next);
    expect(delta.revisionFrom).toBe("r1");
    expect(delta.revisionTo).toBe("r2");
    expect(applyWorldStateDelta(base, delta)).toEqual(next);
  });

  it("ignores generated trees without creating a second scanner", () => {
    expect(isGeneratedTreePath("node_modules/pkg/index.js")).toBe(true);
    expect(isGeneratedTreePath("src/index.ts")).toBe(false);
  });
});
