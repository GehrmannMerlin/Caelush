import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCheckContext } from "./reliability-real-model-eval.mjs";
import { findScenario } from "./reliability-eval-scenarios.mjs";

/**
 * These tests execute a scenario's *real* checks against a simulated workspace: fail first, pass
 * only after the accepted artifact exists. A check that cannot tell the two apart would make the
 * real-model report meaningless, so this is the guard for the evaluation fixtures themselves.
 */

const temporaryRoots = [];

async function fixtureWorkspace(scenario) {
  const root = await mkdtemp(path.join(tmpdir(), `caelush-eval-${scenario.id}-`));
  temporaryRoots.push(root);
  for (const seed of scenario.seeds ?? []) {
    const target = path.join(root, seed.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, seed.content, "utf8");
  }
  return root;
}

async function runChecks(scenario, workspaceRoot, options = {}) {
  const context = createCheckContext({
    workspaceRoot,
    runs: options.runs ?? {},
    contextUsage: options.contextUsage ?? {},
  });
  const checks = await scenario.checks(context);
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("argument-drift fixtures", () => {
  const scenario = findScenario("argument-drift");

  it("fails on the seeded workspace and passes once the source is corrected", async () => {
    const root = await fixtureWorkspace(scenario);
    const before = await runChecks(scenario, root);
    expect(before["check-script-passes"].status).toBe("FAIL");
    expect(before["check-script-unmodified"].status).toBe("PASS");

    await writeFile(
      path.join(root, "src/greeting.mjs"),
      'export const greeting = "hello world";\n',
      "utf8",
    );
    const after = await runChecks(scenario, root);
    expect(after["check-script-passes"].status).toBe("PASS");
  });

  it("notices when the acceptance script itself was rewritten", async () => {
    const root = await fixtureWorkspace(scenario);
    await writeFile(path.join(root, "check-argument.mjs"), "process.exit(0);\n", "utf8");
    const checks = await runChecks(scenario, root);
    expect(checks["check-script-unmodified"].status).toBe("FAIL");
  });
});

describe("capability-fallback fixtures", () => {
  const scenario = findScenario("capability-fallback");

  it("fails without the bundle and passes after the documented fallback runs", async () => {
    const root = await fixtureWorkspace(scenario);
    const before = await runChecks(scenario, root);
    expect(before["fallback-artifact"].status).toBe("FAIL");

    const build = await createCheckContext({
      workspaceRoot: root,
      runs: {},
      contextUsage: {},
    }).node(["tools/build.mjs"]);
    expect(build.stdout).toContain("BUILD_FALLBACK_OK");

    const after = await runChecks(scenario, root);
    expect(after["fallback-artifact"].status).toBe("PASS");
    expect(after["source-unmodified"].status).toBe("PASS");
  });

  it("rejects a bundle whose hash does not belong to the untouched source", async () => {
    const root = await fixtureWorkspace(scenario);
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(
      path.join(root, "dist/bundle.json"),
      `${JSON.stringify({ builder: "node-fallback", sourceSha256: "0".repeat(64) })}\n`,
      "utf8",
    );
    const checks = await runChecks(scenario, root);
    expect(checks["fallback-artifact"].status).toBe("FAIL");
  });
});

describe("failed-check-repair fixtures", () => {
  const scenario = findScenario("failed-check-repair");

  it("fails on the buggy library and passes after the library is fixed", async () => {
    const root = await fixtureWorkspace(scenario);
    const before = await runChecks(scenario, root);
    expect(before["check-script-passes"].status).toBe("FAIL");

    await writeFile(
      path.join(root, "lib/sum.mjs"),
      "export function sum(a, b) {\n  return a + b;\n}\n",
      "utf8",
    );
    const after = await runChecks(scenario, root);
    expect(after["check-script-passes"].status).toBe("PASS");
    expect(after["check-script-unmodified"].status).toBe("PASS");
  });
});

describe("post-compaction-task fixtures", () => {
  const scenario = findScenario("post-compaction-task");

  function corpusTokens() {
    return (scenario.seeds ?? [])
      .filter((seed) => seed.path.startsWith("corpus/"))
      .map((seed) => /TOKEN=(\S+)/u.exec(seed.content)?.[1])
      .filter((token) => token !== undefined);
  }

  it("needs the ordered aggregate, the fixed merge and an observed compaction", async () => {
    const root = await fixtureWorkspace(scenario);
    const tokens = corpusTokens();
    expect(tokens).toHaveLength(12);

    const before = await runChecks(scenario, root);
    expect(before["report-tokens"].status).toBe("FAIL");
    expect(before["apply-check-passes"].status).toBe("FAIL");
    expect(before["history-was-compacted"].status).toBe("BLOCKED");

    await writeFile(
      path.join(root, "report.json"),
      `${JSON.stringify({ tokens }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "apply.mjs"),
      "export function merge(values) {\n  return [...values];\n}\n",
      "utf8",
    );

    const after = await runChecks(scenario, root, {
      contextUsage: { aggregate: { compactionCount: 2 } },
    });
    expect(after["report-tokens"].status).toBe("PASS");
    expect(after["apply-check-passes"].status).toBe("PASS");
    expect(after["history-was-compacted"].status).toBe("PASS");
  });

  it("fails an unordered aggregate instead of accepting the right set", async () => {
    const root = await fixtureWorkspace(scenario);
    const tokens = [...corpusTokens()].reverse();
    await writeFile(
      path.join(root, "report.json"),
      `${JSON.stringify({ tokens }, null, 2)}\n`,
      "utf8",
    );
    const checks = await runChecks(scenario, root, {
      contextUsage: { aggregate: { compactionCount: 1 } },
    });
    expect(checks["report-tokens"].status).toBe("FAIL");
  });
});

describe("failed-history-continue fixtures", () => {
  const scenario = findScenario("failed-history-continue");

  it("requires the sentinel and a completed continuation", async () => {
    const root = await fixtureWorkspace(scenario);
    const runs = {
      history: { status: "CANCELLED" },
      continuation: { status: "COMPLETED" },
    };
    const before = await runChecks(scenario, root, { runs });
    expect(before["history-was-unsuccessful"].status).toBe("PASS");
    expect(before["continuation-artifact"].status).toBe("FAIL");

    await writeFile(path.join(root, "CONTINUE_SENTINEL.txt"), "CONTINUE_SENTINEL_7A2B\n", "utf8");
    const after = await runChecks(scenario, root, { runs });
    expect(after["continuation-artifact"].status).toBe("PASS");
  });

  it("blocks the history conclusion when the historical Run actually completed", async () => {
    const root = await fixtureWorkspace(scenario);
    await writeFile(path.join(root, "CONTINUE_SENTINEL.txt"), "CONTINUE_SENTINEL_7A2B\n", "utf8");
    const checks = await runChecks(scenario, root, {
      runs: { history: { status: "COMPLETED" }, continuation: { status: "COMPLETED" } },
    });
    expect(checks["history-was-unsuccessful"].status).toBe("BLOCKED");
  });
});

describe("low-code-platform fixtures", () => {
  const scenario = findScenario("low-code-platform");

  it("fails missing deliverables and blocks every interactive acceptance item", async () => {
    const root = await fixtureWorkspace(scenario);
    const checks = await runChecks(scenario, root);
    expect(checks["deliverables-present"].status).toBe("FAIL");
    for (const name of [
      "editor-drag-drop",
      "property-panel",
      "undo-redo",
      "schema-save-load",
      "live-preview",
      "publish",
      "reload-persistence",
    ]) {
      expect(checks[name].status).toBe("BLOCKED");
    }
  });
});
