import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import {
  EvalUsageError,
  assertOutsideRepository,
  parseEvalArguments,
  resolveScenarioVerdict,
  runEvaluation,
  sanitizeText,
  summarizeReport,
  toReportPath,
} from "./reliability-real-model-eval.mjs";
import { REAL_MODEL_SCENARIOS, findScenario } from "./reliability-eval-scenarios.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const temporaryRoots = [];

async function temporaryDirectory(prefix = "caelush-eval-test-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function createFakeClient(overrides = {}) {
  const calls = { workspaces: [], sessions: [], runs: [], started: [], cancelled: [] };
  const client = {
    async getHealth() {
      return { status: "ok" };
    },
    async getInfo() {
      return {
        configuredProviders: ["fixture"],
        defaultRunConfiguration: { runtime: { id: "local", kind: "local" } },
      };
    },
    async listAIProviders() {
      return { providers: [{ id: "fixture", credentialConfigured: true }] };
    },
    async getAIModelDirectory() {
      return { models: [{ id: "fixture-model" }] };
    },
    async createWorkspace(input) {
      calls.workspaces.push(input);
      return { id: `ws_${calls.workspaces.length}`, path: input.path };
    },
    async getWorkspaceSecurityCapabilities() {
      return {
        presets: [{ id: "FULL_ACCESS", version: 1, status: "AVAILABLE" }],
        preparation: { supported: false, status: "NOT_REQUIRED" },
      };
    },
    async prepareWorkspaceSecurity() {
      throw new Error("the fixture preset is already available");
    },
    async createSession(input) {
      calls.sessions.push(input);
      return { id: `sess_${calls.sessions.length}` };
    },
    async createRun(sessionId, input) {
      calls.runs.push({ sessionId, input });
      return { id: `run_${calls.runs.length}`, status: "PENDING" };
    },
    async startRun(runId) {
      calls.started.push(runId);
      return { runId, status: "RUNNING" };
    },
    async getRun(runId) {
      return { id: runId, status: "COMPLETED" };
    },
    async cancelRun(runId) {
      calls.cancelled.push(runId);
      return { runId, status: "CANCELLED" };
    },
    async getSessionTranscript() {
      return { items: [] };
    },
    async getSessionTurnPresentation() {
      return { items: [] };
    },
    async getRunContextUsage() {
      return null;
    },
  };
  return { client: { ...client, ...overrides }, calls };
}

function fixtureScenario(overrides = {}) {
  return {
    id: "fixture-scenario",
    title: "Fixture scenario",
    suite: "SMALL",
    rationale: "observed by the test double only",
    limits: { maxSteps: 5, maxToolCalls: 5, timeoutMs: 5_000 },
    seeds: [{ path: "seed.txt", content: "seed\n" }],
    runs: [{ name: "main", prompt: "do the thing" }],
    async checks(context) {
      const seeded = await context.exists("seed.txt");
      return [
        {
          name: "seed-present",
          status: seeded ? "PASS" : "FAIL",
          detail: seeded ? "seed.txt exists" : "seed.txt is missing",
        },
      ];
    },
    ...overrides,
  };
}

async function evaluationOptions(extra = {}) {
  const root = await temporaryDirectory();
  const workspaceRoot = path.join(root, "workspaces");
  const outputDir = path.join(root, "report");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    baseUrl: "http://127.0.0.1:43120",
    provider: "fixture",
    model: "fixture-model",
    workspaceRoot,
    outputDir,
    preset: "FULL_ACCESS",
    requirementFile: undefined,
    scenarios: ["fixture-scenario"],
    help: false,
    ...extra,
  };
}

describe("resolveScenarioVerdict", () => {
  const passed = { name: "artifact", status: "PASS" };
  const completed = [{ name: "main", status: "COMPLETED" }];

  it("passes only when every check passed and every Run completed", () => {
    expect(resolveScenarioVerdict({ checks: [passed], runs: completed })).toEqual({
      status: "PASS",
      reason: "ALL_CHECKS_PASSED",
    });
  });

  it("fails a completed Run whose artifact check failed", () => {
    expect(
      resolveScenarioVerdict({
        checks: [{ name: "artifact", status: "FAIL" }],
        runs: completed,
      }),
    ).toEqual({ status: "FAIL", reason: "CHECK_FAILED:artifact" });
  });

  it("fails a Run that exhausted its budget even when every check passed", () => {
    expect(
      resolveScenarioVerdict({
        checks: [passed],
        runs: [{ name: "main", status: "MAX_STEPS_REACHED" }],
      }),
    ).toEqual({ status: "FAIL", reason: "BUDGET_EXHAUSTED:MAX_STEPS_REACHED" });
  });

  it("fails a Run that ended unsuccessfully without a budget verdict", () => {
    expect(
      resolveScenarioVerdict({ checks: [passed], runs: [{ name: "main", status: "FAILED" }] }),
    ).toEqual({ status: "FAIL", reason: "RUN_FAILED" });
  });

  it("blocks when a check could not be concluded", () => {
    expect(
      resolveScenarioVerdict({
        checks: [passed, { name: "interaction", status: "BLOCKED" }],
        runs: completed,
      }),
    ).toEqual({ status: "BLOCKED", reason: "CHECK_BLOCKED:interaction" });
  });

  it("fails when a scenario produced no checks at all", () => {
    expect(resolveScenarioVerdict({ checks: [], runs: completed })).toEqual({
      status: "FAIL",
      reason: "NO_CHECKS",
    });
  });

  it("reports an explicit block instead of inventing a verdict", () => {
    expect(
      resolveScenarioVerdict({
        checks: [],
        runs: [],
        blockedReason: "MODEL_NOT_AVAILABLE",
      }),
    ).toEqual({ status: "BLOCKED", reason: "MODEL_NOT_AVAILABLE" });
  });
});

describe("sanitizeText", () => {
  it("redacts credentials before bounding the length", () => {
    const text = sanitizeText(
      "request failed key=sk-live-abcdefgh12345678 header=Bearer abcdefghijklmnop apiKey: topsecret",
    );
    expect(text).not.toContain("sk-live-abcdefgh12345678");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("topsecret");
    expect(text).toContain("[redacted");
  });

  it("truncates long detail and says how much was dropped", () => {
    const text = sanitizeText("x".repeat(5_000));
    expect(text.length).toBeLessThan(2_100);
    expect(text.endsWith("…[truncated 3000 chars]")).toBe(true);
  });
});

describe("toReportPath", () => {
  it("keeps paths inside an allowed root relative and hides everything else", () => {
    const root = path.resolve("/tmp/allowed-root");
    expect(toReportPath(path.join(root, "scenario", "a.txt"), [root])).toBe("scenario/a.txt");
    expect(toReportPath(path.resolve("/tmp/elsewhere/secret.txt"), [root])).toBe(
      "<external>/secret.txt",
    );
  });
});

describe("assertOutsideRepository", () => {
  it("refuses a report directory inside the repository", () => {
    expect(() => assertOutsideRepository(path.join(REPOSITORY_ROOT, "reports"))).toThrow(
      EvalUsageError,
    );
  });

  it("accepts a directory outside the repository", () => {
    const outside = path.resolve(REPOSITORY_ROOT, "..", "caelush-eval-outside");
    expect(assertOutsideRepository(outside)).toBe(outside);
  });
});

describe("parseEvalArguments", () => {
  const base = [
    "--base-url",
    "http://127.0.0.1:43120",
    "--provider",
    "fixture",
    "--model",
    "fixture-model",
    "--workspace-root",
    "/tmp/caelush-eval-workspaces",
    "--output-dir",
    "/tmp/caelush-eval-report",
  ];

  it("requires every connection argument", () => {
    expect(() => parseEvalArguments(["--provider", "fixture"])).toThrow(EvalUsageError);
  });

  it("refuses a non-loopback Daemon URL", () => {
    expect(() =>
      parseEvalArguments([...base, "--scenario", "argument-drift"].map((value) =>
        value === "http://127.0.0.1:43120" ? "https://example.com" : value,
      )),
    ).toThrow(EvalUsageError);
  });

  it("expands `all` to the small scenarios and leaves the project scenario manual", () => {
    const parsed = parseEvalArguments([...base, "--scenario", "all"]);
    const projectIds = REAL_MODEL_SCENARIOS.filter((s) => s.suite === "PROJECT").map((s) => s.id);
    expect(parsed.scenarios.length).toBeGreaterThan(0);
    for (const id of projectIds) expect(parsed.scenarios).not.toContain(id);
    expect(parsed.scenarios).toContain("argument-drift");
  });

  it("rejects an unknown scenario instead of silently running nothing", () => {
    expect(() => parseEvalArguments([...base, "--scenario", "nope"])).toThrow(EvalUsageError);
  });

  it("reports help without requiring arguments", () => {
    expect(parseEvalArguments(["--help"]).help).toBe(true);
  });
});

describe("runEvaluation", () => {
  it("passes a scenario whose artifact checks observed the workspace", async () => {
    const options = await evaluationOptions();
    const { client, calls } = createFakeClient();
    const report = await runEvaluation({
      options,
      scenarios: [fixtureScenario()],
      createClient: () => client,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("PASS");
    expect(report.scenarios[0].status).toBe("PASS");
    expect(report.scenarios[0].checks).toEqual([
      { name: "seed-present", status: "PASS", detail: "seed.txt exists" },
    ]);
    expect(calls.runs[0].input.limits).toEqual({ maxSteps: 5, maxToolCalls: 5, timeoutMs: 5_000 });
    expect(calls.runs[0].input.preset).toEqual({ id: "FULL_ACCESS", expectedVersion: 1 });
    expect(calls.runs[0].input.runtime).toEqual({ id: "local", kind: "local" });
    const seeded = await readFile(
      path.join(options.workspaceRoot, "fixture-scenario", "seed.txt"),
      "utf8",
    );
    expect(seeded).toBe("seed\n");
  });

  it("blocks without creating a Run when the model is not offered", async () => {
    const options = await evaluationOptions();
    const { client, calls } = createFakeClient({
      async getAIModelDirectory() {
        return { models: [] };
      },
    });
    const report = await runEvaluation({
      options,
      scenarios: [fixtureScenario()],
      createClient: () => client,
    });

    expect(report.status).toBe("BLOCKED");
    expect(report.scenarios[0].reason).toBe("MODEL_NOT_AVAILABLE");
    expect(calls.runs).toHaveLength(0);
  });

  it("blocks when the provider has no usable credential", async () => {
    const options = await evaluationOptions();
    const { client, calls } = createFakeClient({
      async listAIProviders() {
        return { providers: [{ id: "fixture", credentialConfigured: false }] };
      },
    });
    const report = await runEvaluation({
      options,
      scenarios: [fixtureScenario()],
      createClient: () => client,
    });

    expect(report.scenarios[0].reason).toBe("PROVIDER_CREDENTIAL_MISSING");
    expect(report.status).toBe("BLOCKED");
    expect(calls.runs).toHaveLength(0);
  });

  it("blocks and cancels a Run that waits for an approval that never comes", async () => {
    const options = await evaluationOptions();
    const { client, calls } = createFakeClient({
      async getRun(runId) {
        return { id: runId, status: "WAITING_APPROVAL" };
      },
    });
    const report = await runEvaluation({
      options,
      scenarios: [fixtureScenario()],
      createClient: () => client,
      waitingGraceMs: 0,
    });

    expect(report.scenarios[0].status).toBe("BLOCKED");
    expect(report.scenarios[0].reason).toBe("RUN_WAITING_APPROVAL_UNRESOLVED");
    expect(calls.cancelled).toEqual(["run_1"]);
    expect(report.status).toBe("BLOCKED");
  });

  it("blocks when the daemon fails while dispatching the Run", async () => {
    const options = await evaluationOptions();
    const { client } = createFakeClient({
      async createRun() {
        throw new Error("socket hang up sk-live-shouldnotleak12345");
      },
    });
    const report = await runEvaluation({
      options,
      scenarios: [fixtureScenario()],
      createClient: () => client,
    });

    expect(report.scenarios[0].status).toBe("BLOCKED");
    expect(report.scenarios[0].reason).toContain("RUN_DISPATCH_FAILED");
    expect(JSON.stringify(report)).not.toContain("sk-live-shouldnotleak12345");
  });

  it("fails a completed Run that never produced the artifact", async () => {
    const options = await evaluationOptions();
    const { client } = createFakeClient();
    const scenario = fixtureScenario({
      seeds: [],
      async checks(context) {
        const present = await context.exists("report.json");
        return [
          {
            name: "report-present",
            status: present ? "PASS" : "FAIL",
            detail: present ? "report.json exists" : "report.json missing",
          },
        ];
      },
    });
    const report = await runEvaluation({
      options,
      scenarios: [scenario],
      createClient: () => client,
    });

    expect(report.scenarios[0].status).toBe("FAIL");
    expect(report.scenarios[0].reason).toBe("CHECK_FAILED:report-present");
    expect(report.status).toBe("FAIL");
    expect(report.scenarios[0].unmet).toContain("check:report-present");
  });

  it("reports a cancelled history and a completed continuation separately", async () => {
    const options = await evaluationOptions();
    const statuses = new Map();
    const { client } = createFakeClient({
      async createRun(sessionId, input) {
        const id = `run_${statuses.size + 1}`;
        statuses.set(id, input.userText.includes("first") ? "RUNNING" : "COMPLETED");
        return { id, status: "PENDING" };
      },
      async getRun(runId) {
        return { id: runId, status: statuses.get(runId) ?? "COMPLETED" };
      },
      async cancelRun(runId) {
        statuses.set(runId, "CANCELLED");
        return { runId, status: "CANCELLED" };
      },
    });
    const scenario = fixtureScenario({
      runs: [
        { name: "history", prompt: "first attempt", cancelAfterMs: 0 },
        { name: "continuation", prompt: "second attempt" },
      ],
      toleratedRunStatuses: { history: ["CANCELLED"] },
      async checks(context) {
        return [
          {
            name: "history-status",
            status: context.runs.history.status === "CANCELLED" ? "PASS" : "FAIL",
            detail: `history=${context.runs.history.status}`,
          },
        ];
      },
    });
    const report = await runEvaluation({
      options,
      scenarios: [scenario],
      createClient: () => client,
    });

    expect(report.scenarios[0].runs.map((run) => run.status)).toEqual(["CANCELLED", "COMPLETED"]);
    expect(report.scenarios[0].status).toBe("PASS");
  });

  it("refuses to run the whole-project scenario without the original requirement", async () => {
    const options = await evaluationOptions();
    const { client, calls } = createFakeClient();
    const report = await runEvaluation({
      options,
      scenarios: [findScenario("low-code-platform")],
      createClient: () => client,
    });

    expect(report.scenarios[0].status).toBe("BLOCKED");
    expect(report.scenarios[0].reason).toBe("REQUIREMENT_SOURCE_MISSING");
    expect(calls.runs).toHaveLength(0);
  });

  it("uses the original requirement text as the prompt when it is supplied", async () => {
    const requirement = "请从零开始开发一套可视化低代码平台。";
    const requirementFile = path.join(await temporaryDirectory(), "requirement.txt");
    await writeFile(requirementFile, requirement, "utf8");
    const options = await evaluationOptions({ requirementFile });
    const { client, calls } = createFakeClient();
    await runEvaluation({
      options,
      scenarios: [findScenario("low-code-platform")],
      createClient: () => client,
    });

    expect(calls.runs[0].input.userText).toBe(requirement);
  });

  it("never writes a path or a secret outside the allowed roots", async () => {
    const options = await evaluationOptions();
    const { client } = createFakeClient({
      async createWorkspace() {
        throw new Error(`permission denied for ${path.join(REPOSITORY_ROOT, "packages", "secret")}`);
      },
    });
    const report = await runEvaluation({
      options,
      scenarios: [fixtureScenario()],
      createClient: () => client,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(REPOSITORY_ROOT.replaceAll("\\", "\\\\"));
    expect(report.scenarios[0].workspace).toBe("fixture-scenario");
  });

  it("summarizes every scenario with its verdict", async () => {
    const options = await evaluationOptions();
    const { client } = createFakeClient();
    const report = await runEvaluation({
      options,
      scenarios: [fixtureScenario()],
      createClient: () => client,
    });
    const summary = summarizeReport(report);
    expect(summary.startsWith("RELIABILITY_EVAL_STATUS=PASS")).toBe(true);
    expect(summary).toContain("fixture-scenario (ALL_CHECKS_PASSED)");
  });
});

describe("scenario catalogue", () => {
  it("keeps every check name unique inside its scenario and every id unique overall", () => {
    const ids = REAL_MODEL_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of REAL_MODEL_SCENARIOS) {
      expect(scenario.id).toMatch(/^[a-z0-9-]+$/u);
      expect(typeof scenario.checks).toBe("function");
      expect(scenario.runs.length).toBeGreaterThan(0);
      expect(scenario.limits.maxSteps).toBeGreaterThan(0);
      if (scenario.suite === "PROJECT") {
        expect(scenario.limits).toEqual({
          maxSteps: 300,
          maxToolCalls: 800,
          timeoutMs: 7_200_000,
        });
      } else {
        expect(scenario.limits).toEqual({
          maxSteps: 40,
          maxToolCalls: 100,
          timeoutMs: 600_000,
        });
      }
    }
  });

  it("keeps the production process cwd out of the scenario definitions", () => {
    for (const scenario of REAL_MODEL_SCENARIOS) {
      for (const seed of scenario.seeds ?? []) {
        expect(path.isAbsolute(seed.path)).toBe(false);
        expect(seed.path.includes("..")).toBe(false);
      }
      for (const run of scenario.runs) {
        if (scenario.requiresRequirement === true) continue;
        expect(run.prompt.length).toBeGreaterThan(20);
      }
    }
    expect(process.cwd().length).toBeGreaterThan(0);
  });
});
