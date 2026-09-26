import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWorkspaceId } from "@caelush/protocol";
import { LocalRuntime } from "@caelush/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalProjectInspector } from "../../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Coding Project Intelligence", () => {
  it("detects the workspace root, active package, package manager, scripts and instructions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-project-intelligence-"));
    roots.push(root);
    await mkdir(path.join(root, "apps", "demo"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "workspace-root",
        packageManager: "pnpm@11.21.0",
        scripts: { test: "vitest run" },
      }),
      "utf8",
    );
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "Use the repository conventions.\n", "utf8");
    await writeFile(
      path.join(root, "apps", "demo", "package.json"),
      JSON.stringify({ name: "demo", scripts: { build: "tsc" } }),
      "utf8",
    );

    const runtime = new LocalRuntime();
    try {
      const snapshot = await createLocalProjectInspector(runtime).inspect({
        workspace: { id: createWorkspaceId(), path: root },
        cwd: "apps/demo",
      });

      expect(snapshot.projectRoot.reason).toBe("WORKSPACE_MARKER");
      expect(snapshot.profile.packageManager).toMatchObject({
        name: "pnpm",
        versionHint: "11.21.0",
        source: "PACKAGE_MANAGER_FIELD",
      });
      expect(snapshot.profile.isMonorepo).toBe(true);
      expect(snapshot.profile.rootPackage?.scripts).toEqual([
        { name: "test", command: "vitest run" },
      ]);
      expect(snapshot.profile.activePackage?.scripts).toEqual([{ name: "build", command: "tsc" }]);
      expect(snapshot.instructions.entries[0]?.content).toContain("repository conventions");
    } finally {
      await runtime.dispose();
    }
  });
});
