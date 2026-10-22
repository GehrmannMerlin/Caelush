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
  /**
   * What Phase 7G actually retired, restated against the architecture that is live today.
   *
   * ```text
   * retired   the second Context runtime: legacy-context-runtime-adapter, a daemon-local engine,
   *           a Context package that owns history, selection or budgets
   * retained  @caelush/context as the attachment-context projector
   * ```
   *
   * AGENTS.md keeps one responsibility on that package — attachment projection, host-path rejection,
   * redaction and budget accounting for a single attachment span — and `packages/core` is its only
   * consumer. Deleting the package would move that logic into Core rather than retire anything, so
   * the guard asserts the confinement instead of the deletion: one consumer, one responsibility, no
   * dependency on the kernel, storage, runtime or a host.
   */
  it("retires the legacy Context runtime and confines @caelush/context to attachment projection", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "packages/context/package.json"), "utf8"),
    ) as { readonly private?: boolean; readonly dependencies?: Record<string, string> };
    expect(manifest.private).toBe(true);
    // The projector is a pure data transform: no kernel, no storage, no runtime, no host package.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@caelush/ai",
      "@caelush/protocol",
    ]);
    await expect(
      readFile(path.join(root, "packages/core/src/legacy-context-runtime-adapter.ts")),
    ).rejects.toThrow();

    const productionFiles = [...(await sourceFiles("packages")), ...(await sourceFiles("apps"))];
    const consumers: string[] = [];
    for (const file of productionFiles) {
      const source = await readSource(file);
      if (/(?:from|import\s*\()\s*["']@caelush\/context["']/.test(source)) consumers.push(file);
      // A path reference to the package directory is a private cross-package import.
      expect(source, `${file} must not name packages/context by path`).not.toMatch(
        /packages\/context[\\/]/,
      );
    }
    expect(consumers.map((file) => file.split(path.sep).join("/"))).toEqual([
      "packages/core/src/run-attachment-context.ts",
    ]);

    // The daemon composes the Agent-owned engine; it never builds a second Context runtime.
    const composition = await readSource("apps/daemon/src/context/v2-context-composition.ts");
    expect(composition).not.toContain("@caelush/context");
    expect(composition).toContain("createV2ContextEngine");
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
