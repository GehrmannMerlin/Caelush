import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { scanner } from "./support/architecture-checker.js";
import { repositoryRoot } from "./support/workspace.js";

const legacyPackageDirectory = path.join(repositoryRoot, "packages", "events");
const generatedDirectories = new Set([
  "node_modules",
  "dist",
  "coverage",
  "build",
  ".cache",
  "test",
]);

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function productionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !generatedDirectories.has(entry.name)) {
      files.push(...(await productionSourceFiles(entryPath)));
    } else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("Architecture V2 Phase 6H legacy Event package retirement", () => {
  it("keeps the legacy package physically absent and out of the workspace graph", async () => {
    await expect(access(legacyPackageDirectory)).rejects.toThrow();

    const scan = await scanner.scanWorkspace(repositoryRoot);
    expect(scan.projects.some((project) => project.identity === "events")).toBe(false);
    expect(scan.manifestEdges).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ targetPackage: "events" })]),
    );
    expect(scan.sourceEdges.filter((edge) => edge.targetPackage === "events")).toEqual([]);
  });

  it("keeps the lockfile free of the retired workspace importer and link", async () => {
    const lockfile = await read("pnpm-lock.yaml");
    expect(lockfile).not.toContain("link:../../packages/events");
    expect(lockfile.split(/\r?\n/)).not.toContain("  packages/events:");
  });

  it("preserves canonical Event ownership after package retirement", async () => {
    expect(await read("packages/protocol/src/events/index.ts")).toContain("RunEventSchema");
    const agent = await read("packages/agent/src/index.ts");
    expect(agent).toContain("DurableRunEventDraft");
    expect(agent).toContain("RunEventNotifierPort");
    expect(agent).toContain("DurableRunEventReaderPort");
    expect(await read("packages/storage/src/events/sqlite-durable-event-store.ts")).toContain(
      "implements DurableRunEventReaderPort",
    );
    expect(await read("packages/storage/src/events/sqlite-durable-event-store.ts")).toContain(
      "appendDurableEventsInTransaction",
    );
    expect(await read("apps/daemon/src/events/run-event-hub.ts")).toContain("class RunEventHub");
    expect(await read("apps/daemon/src/events/public-event-projector.ts")).toContain(
      "PublicEventProjector",
    );
  });

  it("does not leave a second EventBus runtime in production source", async () => {
    const roots = [path.join(repositoryRoot, "apps"), path.join(repositoryRoot, "packages")];
    const files = (await Promise.all(roots.map((root) => productionSourceFiles(root)))).flat();
    const source = await Promise.all(files.map((file) => readFile(file, "utf8")));
    expect(source.join("\n")).not.toMatch(
      /\bclass\s+(?:EventBus|LegacyEventBus|CompatibilityEventBus|AgentEventBus)\b/,
    );
  });
});
