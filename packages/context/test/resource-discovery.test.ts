import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalProjectInspector, createLocalRelevantFilePlanner } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resource-bounded discovery", () => {
  it("keeps broad discovery bounded to the workspace and reports truncation", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-resource-discovery-parent-"));
    const root = path.join(parent, "workspace");
    directories.push(parent);
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(parent, "outside.ts"), "must not be discovered", "utf8");
    await writeFile(path.join(root, "package.json"), '{"name":"bounded"}', "utf8");
    await writeFile(path.join(root, "src", "one.ts"), "export const one = 1;", "utf8");
    await writeFile(path.join(root, "src", "nested", "two.ts"), "export const two = 2;", "utf8");

    const snapshot = await createLocalProjectInspector().inspect({
      workspace: { id: createWorkspaceId(), path: root },
    });
    const plan = await createLocalRelevantFilePlanner().plan({
      snapshot,
      query: { text: "typescript" },
      discovery: { maxVisitedEntries: 3, maxCandidateFiles: 1, maxDepth: 2 },
    });

    expect(plan.discovery.visitedEntries).toBeLessThanOrEqual(3);
    expect(plan.discovery.candidateFiles).toBeLessThanOrEqual(1);
    expect(plan.discovery.truncatedByLimit).toBe(true);
    expect(plan.rankedCandidates.map((candidate) => candidate.path)).not.toContain(
      path.join(parent, "outside.ts"),
    );
  });
});
