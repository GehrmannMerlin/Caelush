import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function sourceFiles(relativeDirectory: string): Promise<string[]> {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") {
        return sourceFiles(relative);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [relative] : [];
    }),
  );
  return nested.flat();
}

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("Phase 7G Context Engineering V2 final acceptance", () => {
  it("retires the package and every live production consumer", async () => {
    await expect(readFile(path.join(root, "packages/context/package.json"))).rejects.toThrow();
    await expect(
      readFile(path.join(root, "packages/core/src/legacy-context-runtime-adapter.ts")),
    ).rejects.toThrow();

    const productionFiles = [...(await sourceFiles("packages")), ...(await sourceFiles("apps"))];
    const offenders: string[] = [];
    for (const file of productionFiles) {
      const source = await readSource(file);
      if (
        /(?:from|import\s*\()\s*["']@caelush\/context["']/.test(source) ||
        /packages\/context[\\/]/.test(source)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps V2 authority in Agent, Coding Agent, Core integration and Daemon projection", async () => {
    const agent = await readSource("packages/agent/src/context/engine/context-engine.ts");
    const coding = await readSource("packages/coding-agent/src/context/project-intelligence.ts");
    const core = await readSource("packages/core/src/verification-profile-provider.ts");
    const daemon = await readSource("apps/daemon/src/context/v2-context-composition.ts");
    const composition = await readSource("apps/daemon/src/daemon-composition.ts");

    expect(agent).toContain("export function createV2ContextEngine");
    expect(coding).toContain("export function createLocalProjectInspector");
    expect(coding).toContain("RuntimeWorkspaceScope");
    expect(core).toContain("CoreProjectProfileInspector");
    expect(core).not.toMatch(/from\s+["']@caelush\/coding-agent["']/);
    expect(daemon).toContain("createV2ContextEngine");
    expect(composition).toContain("createLocalProjectInspector(runtime)");
    expect(composition).toContain("type ContextUsageProjection");
    expect(composition).not.toContain("contextRuntime");
  });

  it("preserves V1 checkpoint decode compatibility while writing V2 checkpoints", async () => {
    const engine = await readSource("packages/agent/src/context/engine/context-engine.ts");
    const contracts = await readSource(
      "packages/agent/src/context/compaction/context-compaction-contracts.ts",
    );
    const storage = await readSource("packages/storage/src/context-checkpoint-repository-v2.ts");

    expect(contracts).toContain("export interface LegacyContextCheckpointRecordV1");
    expect(engine).toContain("LegacyContextCheckpointRecordV1");
    expect(storage).toContain("LegacyContextCheckpointRecordV1");
    expect(storage).toContain("writeContextCheckpointV2InTransaction");
  });

  it("keeps Tool observation bounding and model feedback on one Agent-owned path", async () => {
    const projector = await readSource(
      "packages/agent/src/tools/observation/tool-observation-projector.ts",
    );
    const core = await readSource("packages/core/src/agent-tool-batch.ts");
    const daemon = await readSource("apps/daemon/src/daemon-composition.ts");

    expect(projector).toContain("export function createToolObservationBatchProjector");
    expect(projector).toContain("const OMITTED");
    expect(core).toContain("createToolObservationBatchProjector()");
    expect(daemon).toContain("createModelToolFeedbackProjector");
    expect(daemon).toContain("toContextObservationProjection()");
  });

  it("keeps the Protocol API and durable context stores unchanged at the boundary", async () => {
    const protocol = await readSource("packages/protocol/src/api/context-usage.ts");
    const storage = await readSource("packages/storage/src/context-usage-store.ts").catch(() => "");
    const daemonRoutes = await readSource("apps/daemon/src/routes/execution.ts");

    expect(protocol).toContain("ContextUsageProjectionSchema");
    expect(daemonRoutes).toContain("ContextUsageResponseSchema");
    expect(daemonRoutes).toContain("ContextUsageProjection");
    expect(storage === "" || storage.includes("ContextUsage")).toBe(true);
  });
});
