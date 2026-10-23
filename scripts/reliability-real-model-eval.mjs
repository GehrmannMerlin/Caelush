#!/usr/bin/env node
/**
 * Explicit real-model reliability evaluation.
 *
 * This runner talks to an *already running* loopback Daemon through `@caelush/client` only. It does
 * not construct an Agent, a Provider or a Tool executor, so it cannot manufacture a green result by
 * bypassing the product. Credentials stay in the Daemon: nothing secret is accepted on argv, and
 * every string written to the report passes `sanitizeText`.
 *
 * The runner never runs as part of `pnpm test` / `pnpm check`. See
 * `docs/architecture/agent-reliability-evaluation.md`.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CaelushClient } from "@caelush/client";
import {
  REAL_MODEL_SCENARIOS,
  findScenario,
  listScenarioIds,
} from "./reliability-eval-scenarios.mjs";

const execFileAsync = promisify(execFile);

export const REPORT_SCHEMA_VERSION = 1;
/** A report may only carry these four verdicts; anything else is a defect, not a result. */
export const REPORT_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]);
export const CHECK_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED", "SKIP"]);

const SUCCESSFUL_RUN_STATUSES = new Set(["COMPLETED"]);
const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "MAX_STEPS_REACHED",
  "BUDGET_EXCEEDED",
]);
const BUDGET_RUN_STATUSES = new Set(["TIMEOUT", "MAX_STEPS_REACHED", "BUDGET_EXCEEDED"]);
const WAITING_RUN_STATUSES = new Set(["WAITING_APPROVAL", "WAITING_RESOURCE"]);
const MAX_DETAIL_CHARS = 2_000;
const MAX_COMMAND_OUTPUT_CHARS = 16 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
/** How long a Run may sit in a waiting state before the runner refuses to call it a pass. */
const DEFAULT_WAITING_GRACE_MS = 120_000;
/** Terminal states are reached by the Daemon, not by this runner; allow the budget plus slack. */
const TERMINAL_SLACK_MS = 120_000;

export class EvalUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvalUsageError";
  }
}

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage:
  node scripts/reliability-real-model-eval.mjs \\
    --base-url <loopback daemon> \\
    --provider <configured provider id> \\
    --model <configured model id> \\
    --workspace-root <new directory outside the repository> \\
    --output-dir <directory outside the repository> \\
    [--scenario <id>|all]... [--preset FULL_ACCESS|WORKSPACE_WRITE|VIEW_ONLY]
    [--requirement-file <original low-code requirement>]

Scenarios: ${listScenarioIds().join(", ")}

The low-code-platform scenario only runs with --requirement-file: the original user requirement is
not duplicated in the repository.`;

/** @param {string[]} argv */
export function parseEvalArguments(argv) {
  const parsed = {
    baseUrl: undefined,
    provider: undefined,
    model: undefined,
    workspaceRoot: undefined,
    outputDir: undefined,
    requirementFile: undefined,
    preset: "FULL_ACCESS",
    scenarios: [],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new EvalUsageError(`${flag} requires a value.`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--base-url":
        parsed.baseUrl = next();
        break;
      case "--provider":
        parsed.provider = next();
        break;
      case "--model":
        parsed.model = next();
        break;
      case "--workspace-root":
        parsed.workspaceRoot = next();
        break;
      case "--output-dir":
        parsed.outputDir = next();
        break;
      case "--requirement-file":
        parsed.requirementFile = next();
        break;
      case "--preset":
        parsed.preset = next();
        break;
      case "--scenario": {
        const value = next();
        for (const id of value.split(",")) {
          const trimmed = id.trim();
          if (trimmed.length === 0) continue;
          parsed.scenarios.push(trimmed);
        }
        break;
      }
      default:
        throw new EvalUsageError(`Unknown argument: ${flag}`);
    }
  }
  if (parsed.help) return parsed;
  for (const [flag, value] of [
    ["--base-url", parsed.baseUrl],
    ["--provider", parsed.provider],
    ["--model", parsed.model],
    ["--workspace-root", parsed.workspaceRoot],
    ["--output-dir", parsed.outputDir],
  ]) {
    if (value === undefined) throw new EvalUsageError(`${flag} is required.`);
  }
  if (parsed.scenarios.length === 0) throw new EvalUsageError("--scenario is required.");
  if (!["FULL_ACCESS", "WORKSPACE_WRITE", "VIEW_ONLY"].includes(parsed.preset)) {
    throw new EvalUsageError(`Unsupported --preset: ${parsed.preset}`);
  }
  const resolvedScenarios = parsed.scenarios.includes("all")
    ? REAL_MODEL_SCENARIOS.filter((scenario) => scenario.suite === "SMALL").map(
        (scenario) => scenario.id,
      )
    : parsed.scenarios;
  for (const id of resolvedScenarios) {
    if (findScenario(id) === null) {
      throw new EvalUsageError(`Unknown scenario: ${id}`);
    }
  }
  return Object.freeze({
    ...parsed,
    baseUrl: normalizeBaseUrl(parsed.baseUrl),
    workspaceRoot: path.resolve(parsed.workspaceRoot),
    outputDir: path.resolve(parsed.outputDir),
    requirementFile:
      parsed.requirementFile === undefined ? undefined : path.resolve(parsed.requirementFile),
    scenarios: Object.freeze([...new Set(resolvedScenarios)]),
  });
}

function normalizeBaseUrl(value) {
  const url = new globalThis.URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new EvalUsageError("--base-url must be an http loopback Daemon URL.");
  }
  return `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
}

/** The report and the workspaces must stay outside the repository. */
export function assertOutsideRepository(directory, repositoryRoot = REPOSITORY_ROOT) {
  const resolved = path.resolve(directory);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new EvalUsageError(`${resolved} is inside the repository; choose a path outside it.`);
  }
  return resolved;
}

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{8,}/gu, "sk-[redacted]"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*/giu, "$1[redacted]"],
  [
    /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b\s*[:=]\s*"?)[^"\s,}]+/giu,
    "$1[redacted]",
  ],
];

/** Every report string passes through here: redact first, then bound the length. */
export function sanitizeText(value, maxChars = MAX_DETAIL_CHARS) {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  text = text.split(String.fromCharCode(0)).join("");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

/**
 * Report paths stay relative to an allowed root. Anything else is replaced with its basename, so a
 * machine-specific absolute path never leaks into a shared report.
 * @param {string} target
 * @param {string[]} roots
 */
export function toReportPath(target, roots) {
  const resolved = path.resolve(target);
  for (const root of roots) {
    const relative = path.relative(path.resolve(root), resolved);
    if (relative === "") return ".";
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/");
    }
  }
  return `<external>/${path.basename(resolved)}`;
}

/**
 * A free-form detail or reason may embed an absolute path inside an error message. Allowed roots
 * collapse to `<root>`; any other drive-absolute path collapses to `<external>/<basename>`.
 * @param {unknown} value
 * @param {string[]} roots
 */
export function sanitizePath(value, roots) {
  let text = sanitizeText(value);
  for (const root of roots) {
    if (root.length === 0) continue;
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    text = text.replace(new RegExp(escaped, "giu"), "<root>");
  }
  text = text.replace(/[A-Za-z]:\\[^\s"',;)]*/gu, (match) => `<external>/${path.basename(match)}`);
  return text;
}

/**
 * Aggregate a scenario's observed facts into one verdict.
 *
 * Precedence: an explicit block wins over everything, then a failed check, then an exhausted
 * budget, then a blocked check. A scenario only passes when every check passed *and* every Run
 * reached a successful terminal state.
 * @param {{ checks: Array<{ name: string, status: string }>, runs: Array<{ name: string, status: string }>, blockedReason?: string }} input
 */
export function resolveScenarioVerdict(input) {
  const checks = input.checks ?? [];
  const runs = input.runs ?? [];
  if (input.blockedReason !== undefined) {
    return { status: "BLOCKED", reason: input.blockedReason };
  }
  if (checks.length === 0) return { status: "FAIL", reason: "NO_CHECKS" };
  const failed = checks.filter((check) => check.status === "FAIL");
  if (failed.length > 0) return { status: "FAIL", reason: `CHECK_FAILED:${failed[0].name}` };
  const budget = runs.find((run) => BUDGET_RUN_STATUSES.has(run.status));
  if (budget !== undefined) return { status: "FAIL", reason: `BUDGET_EXHAUSTED:${budget.status}` };
  const unsuccessful = runs.find((run) => !SUCCESSFUL_RUN_STATUSES.has(run.status));
  if (unsuccessful !== undefined) {
    return { status: "FAIL", reason: `RUN_${unsuccessful.status}` };
  }
  const blocked = checks.filter((check) => check.status === "BLOCKED");
  if (blocked.length > 0) return { status: "BLOCKED", reason: `CHECK_BLOCKED:${blocked[0].name}` };
  if (checks.some((check) => check.status !== "PASS")) {
    return { status: "BLOCKED", reason: "CHECK_NOT_CONCLUSIVE" };
  }
  return { status: "PASS", reason: "ALL_CHECKS_PASSED" };
}

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function sha256File(target) {
  try {
    const bytes = await readFile(target);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

async function existsFile(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readTextOrNull(target) {
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

async function runNodeScript(workspaceRoot, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: workspaceRoot,
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * MAX_COMMAND_OUTPUT_CHARS,
    });
    return {
      code: 0,
      stdout: String(stdout).slice(0, MAX_COMMAND_OUTPUT_CHARS),
      stderr: String(stderr).slice(0, MAX_COMMAND_OUTPUT_CHARS),
    };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : null,
      stdout: String(error?.stdout ?? "").slice(0, MAX_COMMAND_OUTPUT_CHARS),
      stderr: String(error?.stderr ?? error?.message ?? "").slice(0, MAX_COMMAND_OUTPUT_CHARS),
    };
  }
}

/**
 * Build the context a scenario's checks receive. Exported so the fixture tests can execute the real
 * checks against a simulated workspace without a Daemon or a model.
 * @param {{
 *   workspaceRoot: string,
 *   runs: Record<string, any>,
 *   contextUsage: Record<string, any>,
 * }} input
 */
export function createCheckContext({ workspaceRoot, runs, contextUsage }) {
  return {
    workspaceRoot,
    runs,
    contextUsage,
    node: (args, options = {}) => runNodeScript(workspaceRoot, args, options.timeoutMs),
    read: (relativePath) => readTextOrNull(path.join(workspaceRoot, relativePath)),
    exists: (relativePath) => existsFile(path.join(workspaceRoot, relativePath)),
    hash: (relativePath) => sha256File(path.join(workspaceRoot, relativePath)),
    json: async (relativePath) => {
      const text = await readTextOrNull(path.join(workspaceRoot, relativePath));
      if (text === null) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}

async function seedWorkspace(workspaceRoot, seeds = []) {
  await mkdir(workspaceRoot, { recursive: true });
  for (const seed of seeds) {
    const target = path.join(workspaceRoot, seed.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, seed.content, "utf8");
  }
}

async function resolvePreset(client, workspaceId, presetId) {
  let capabilities = await client.getWorkspaceSecurityCapabilities(workspaceId);
  let entry = capabilities.presets.find((preset) => preset.id === presetId);
  if (entry === undefined) return { error: "PRESET_NOT_OFFERED" };
  if (entry.status === "PREPARATION_REQUIRED") {
    try {
      await client.prepareWorkspaceSecurity(workspaceId, {
        id: entry.id,
        expectedVersion: entry.version,
      });
    } catch (error) {
      return { error: `PRESET_PREPARATION_FAILED:${sanitizeText(error?.message ?? error, 200)}` };
    }
    capabilities = await client.getWorkspaceSecurityCapabilities(workspaceId);
    entry = capabilities.presets.find((preset) => preset.id === presetId);
    if (entry === undefined) return { error: "PRESET_NOT_OFFERED" };
  }
  if (entry.status !== "AVAILABLE") return { error: `PRESET_${entry.status}` };
  return { preset: { id: entry.id, expectedVersion: entry.version } };
}

async function preflight(client, options) {
  try {
    await client.getHealth();
  } catch (error) {
    return { error: `DAEMON_UNREACHABLE:${sanitizeText(error?.message ?? error, 200)}` };
  }
  let info;
  try {
    info = await client.getInfo();
  } catch (error) {
    return { error: `DAEMON_INFO_FAILED:${sanitizeText(error?.message ?? error, 200)}` };
  }
  if (
    !Array.isArray(info?.configuredProviders) ||
    !info.configuredProviders.includes(options.provider)
  ) {
    return { error: "PROVIDER_NOT_CONFIGURED" };
  }
  try {
    const providers = await client.listAIProviders();
    const provider = providers.providers.find((entry) => entry.id === options.provider);
    if (provider === undefined) return { error: "PROVIDER_NOT_CONFIGURED" };
    if (provider.credentialConfigured !== true) return { error: "PROVIDER_CREDENTIAL_MISSING" };
  } catch (error) {
    return { error: `PROVIDER_LOOKUP_FAILED:${sanitizeText(error?.message ?? error, 200)}` };
  }
  try {
    const directory = await client.getAIModelDirectory(options.provider);
    const models = Array.isArray(directory?.models) ? directory.models : [];
    if (!models.some((model) => model.id === options.model))
      return { error: "MODEL_NOT_AVAILABLE" };
  } catch (error) {
    return { error: `MODEL_LOOKUP_FAILED:${sanitizeText(error?.message ?? error, 200)}` };
  }
  return { info };
}

async function executeRun({
  client,
  sessionId,
  workspace,
  preset,
  runtime,
  options,
  runDefinition,
  waitingGraceMs,
}) {
  const created = await client.createRun(sessionId, {
    goal: runDefinition.prompt,
    userText: runDefinition.prompt,
    workspace,
    model: { provider: options.provider, model: options.model },
    runtime,
    preset,
    limits: runDefinition.limits,
  });
  const startedAtMs = Date.now();
  await client.startRun(created.id);
  const cancelAt =
    runDefinition.cancelAfterMs === undefined ? null : startedAtMs + runDefinition.cancelAfterMs;
  const deadline = startedAtMs + (runDefinition.limits?.timeoutMs ?? 600_000) + TERMINAL_SLACK_MS;
  let waitingSince = null;
  let cancelRequested = false;
  while (Date.now() < deadline) {
    if (cancelAt !== null && !cancelRequested && Date.now() >= cancelAt) {
      cancelRequested = true;
      await client.cancelRun(created.id).catch(() => undefined);
    }
    const current = await client.getRun(created.id);
    if (TERMINAL_RUN_STATUSES.has(current.status)) {
      return { name: runDefinition.name, runId: created.id, run: current };
    }
    if (WAITING_RUN_STATUSES.has(current.status)) {
      waitingSince ??= Date.now();
      if (Date.now() - waitingSince >= waitingGraceMs) {
        await client.cancelRun(created.id).catch(() => undefined);
        return {
          name: runDefinition.name,
          runId: created.id,
          run: current,
          blockedReason: `RUN_${current.status}_UNRESOLVED`,
        };
      }
    } else {
      waitingSince = null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  await client.cancelRun(created.id).catch(() => undefined);
  const last = await client.getRun(created.id).catch(() => created);
  return {
    name: runDefinition.name,
    runId: created.id,
    run: last,
    blockedReason: "RUN_DID_NOT_REACH_TERMINAL_STATE",
  };
}

async function readUsage(client, runId) {
  const usage = await client.getRunContextUsage(runId).catch(() => null);
  if (usage === null || usage === undefined) return null;
  return {
    contextWindowTokens: usage.contextWindowTokens,
    estimatedInputTokens: usage.estimatedInputTokens,
    compactionCount: usage.compactionCount,
    pressureState: usage.pressureState,
    usedRatio: usage.usedRatio,
  };
}

async function evaluateScenario({ client, options, scenario, requirementText, waitingGraceMs }) {
  if (scenario.requiresRequirement === true && (requirementText ?? "").trim().length === 0) {
    return blockedScenario(scenario, options, "REQUIREMENT_SOURCE_MISSING");
  }
  const preflightResult = await preflight(client, options);
  if (preflightResult.error !== undefined) {
    return blockedScenario(scenario, options, preflightResult.error);
  }

  const scenarioRoot = path.join(options.workspaceRoot, scenario.id);
  try {
    await seedWorkspace(scenarioRoot, scenario.seeds ?? []);
  } catch (error) {
    return blockedScenario(
      scenario,
      options,
      `WORKSPACE_SEED_FAILED:${sanitizeText(error?.message ?? error, 200)}`,
    );
  }

  let workspace;
  try {
    workspace = await client.createWorkspace({ path: scenarioRoot, displayName: scenario.id });
  } catch (error) {
    return blockedScenario(
      scenario,
      options,
      `WORKSPACE_CREATE_FAILED:${sanitizeText(error?.message ?? error, 200)}`,
    );
  }

  const preset = await resolvePreset(client, workspace.id, options.preset).catch((error) => ({
    error: `PRESET_LOOKUP_FAILED:${sanitizeText(error?.message ?? error, 200)}`,
  }));
  if (preset.error !== undefined) {
    return { ...blockedScenario(scenario, options, preset.error), workspaceId: workspace.id };
  }

  const runtime = preflightResult.info?.defaultRunConfiguration?.runtime;
  if (runtime === undefined) {
    return {
      ...blockedScenario(scenario, options, "RUNTIME_REF_MISSING"),
      workspaceId: workspace.id,
    };
  }

  let session;
  try {
    session = await client.createSession({
      title: `reliability-eval:${scenario.id}`,
      workspaceId: workspace.id,
      defaultWorkspace: { id: workspace.id, path: workspace.path },
      defaultModel: { provider: options.provider, model: options.model },
    });
  } catch (error) {
    return {
      ...blockedScenario(
        scenario,
        options,
        `SESSION_CREATE_FAILED:${sanitizeText(error?.message ?? error, 200)}`,
      ),
      workspaceId: workspace.id,
    };
  }

  const workspaceRef = { id: workspace.id, path: workspace.path };
  const runs = new Map();
  const runRecords = [];
  let blockedReason;
  for (const runDefinition of scenario.runs) {
    let outcome;
    try {
      outcome = await executeRun({
        client,
        sessionId: session.id,
        workspace: workspaceRef,
        preset: preset.preset,
        runtime,
        options,
        runDefinition: {
          ...runDefinition,
          prompt: scenario.requiresRequirement === true ? requirementText : runDefinition.prompt,
          limits: scenario.limits,
        },
        waitingGraceMs,
      });
    } catch (error) {
      blockedReason = `RUN_DISPATCH_FAILED:${sanitizeText(error?.message ?? error, 200)}`;
      break;
    }
    runs.set(outcome.name, outcome.run ?? { status: "UNKNOWN" });
    runRecords.push({
      name: outcome.name,
      runId: outcome.runId,
      status: outcome.run?.status ?? "UNKNOWN",
    });
    if (outcome.blockedReason !== undefined) {
      blockedReason = outcome.blockedReason;
      break;
    }
  }

  const contextUsage = {};
  for (const record of runRecords) {
    contextUsage[record.name] = await readUsage(client, record.runId);
  }

  let checks = [];
  if (blockedReason === undefined) {
    const context = createCheckContext({
      workspaceRoot: scenarioRoot,
      runs: Object.fromEntries(runs),
      contextUsage,
    });
    try {
      checks = await scenario.checks(context);
    } catch (error) {
      checks = [
        {
          name: "checks-executed",
          status: "BLOCKED",
          detail: `the evaluator could not complete its own checks: ${sanitizeText(error?.message ?? error, 400)}`,
        },
      ];
    }
  }

  const normalizedChecks = checks.map((check) => ({
    name: String(check.name).slice(0, 120),
    status: CHECK_STATUSES.includes(check.status) ? check.status : "BLOCKED",
    detail: sanitizeText(check.detail),
  }));
  /**
   * A scenario may deliberately contain an unsuccessful historical Run. Only the statuses the
   * scenario declares as expected are excluded from the verdict; a scenario cannot declare every
   * status, because the declaration is per Run name.
   */
  const tolerated = scenario.toleratedRunStatuses ?? {};
  const verdictRuns = runRecords.filter(
    (record) => !(tolerated[record.name] ?? []).includes(record.status),
  );
  const verdict = resolveScenarioVerdict({
    checks: normalizedChecks,
    runs: verdictRuns,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  });
  const unmet = [
    ...normalizedChecks
      .filter((check) => check.status !== "PASS")
      .map((check) => `check:${check.name}`),
    ...runRecords
      .filter((record) => !SUCCESSFUL_RUN_STATUSES.has(record.status))
      .filter((record) => !(tolerated[record.name] ?? []).includes(record.status))
      .map((record) => `run:${record.name}:${record.status}`),
  ];
  return {
    id: scenario.id,
    title: scenario.title,
    suite: scenario.suite,
    rationale: scenario.rationale,
    status: verdict.status,
    reason: sanitizeText(verdict.reason, 300),
    limits: { ...scenario.limits },
    workspace: toReportPath(scenarioRoot, [options.workspaceRoot]),
    workspaceId: workspace.id,
    sessionId: session.id,
    runs: runRecords,
    checks: normalizedChecks,
    usage: contextUsage,
    unmet,
  };
}

function blockedScenario(scenario, options, reason) {
  return {
    id: scenario.id,
    title: scenario.title,
    suite: scenario.suite,
    rationale: scenario.rationale,
    status: "BLOCKED",
    reason: sanitizeText(reason, 300),
    limits: { ...scenario.limits },
    workspace: toReportPath(path.join(options.workspaceRoot, scenario.id), [options.workspaceRoot]),
    runs: [],
    checks: [],
    usage: {},
    unmet: ["scenario:not-executed"],
  };
}

function aggregateStatus(results) {
  if (results.length === 0) return "NOT_RUN";
  if (results.some((result) => result.status === "FAIL")) return "FAIL";
  if (results.some((result) => result.status === "BLOCKED")) return "BLOCKED";
  if (results.every((result) => result.status === "PASS")) return "PASS";
  return "NOT_RUN";
}

async function readSourceHead() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      windowsHide: true,
    });
    return String(stdout).trim();
  } catch {
    return "UNKNOWN";
  }
}

/**
 * Execute the selected scenarios against an already running Daemon.
 *
 * `createClient` is injectable so the runner's own behaviour can be tested without a model.
 * @param {{
 *   options: ReturnType<typeof parseEvalArguments>,
 *   scenarios?: ReadonlyArray<any>,
 *   createClient?: (options: any) => any,
 *   waitingGraceMs?: number,
 *   now?: () => Date,
 * }} input
 */
export async function runEvaluation(input) {
  const options = input.options;
  const scenarios = input.scenarios ?? options.scenarios.map((id) => findScenario(id));
  const createClient =
    input.createClient ?? ((config) => new CaelushClient({ baseUrl: config.baseUrl }));
  const waitingGraceMs = input.waitingGraceMs ?? DEFAULT_WAITING_GRACE_MS;
  const now = input.now ?? (() => new Date());
  const requirementText =
    options.requirementFile === undefined
      ? undefined
      : await readFile(options.requirementFile, "utf8").catch(() => undefined);

  const startedAt = now();
  const results = [];
  let client;
  try {
    client = createClient(options);
  } catch (error) {
    const failure = sanitizeText(error?.message ?? error, 300);
    for (const scenario of scenarios) {
      results.push(blockedScenario(scenario, options, `CLIENT_CREATE_FAILED:${failure}`));
    }
    return buildReport({ options, results, startedAt, now });
  }

  for (const scenario of scenarios) {
    results.push(
      await evaluateScenario({ client, options, scenario, requirementText, waitingGraceMs }),
    );
  }
  return buildReport({ options, results, startedAt, now });
}

function deepSanitizePaths(value, roots) {
  if (typeof value === "string") return sanitizePath(value, roots);
  if (Array.isArray(value)) return value.map((entry) => deepSanitizePaths(entry, roots));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepSanitizePaths(entry, roots)]),
    );
  }
  return value;
}

async function buildReport({ options, results, startedAt, now }) {
  const status = aggregateStatus(results);
  const roots = [options.workspaceRoot, options.outputDir];
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    source: {
      head: await readSourceHead(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    daemon: { baseUrl: sanitizeText(options.baseUrl, 200) },
    model: {
      provider: sanitizeText(options.provider, 120),
      model: sanitizeText(options.model, 120),
    },
    preset: options.preset,
    requirementSource:
      options.requirementFile === undefined
        ? "NOT_PROVIDED"
        : toReportPath(options.requirementFile, roots),
    scenarios: results.map((result) => deepSanitizePaths(result, roots)),
    notes: [
      "A PASS covers only this model, this configuration and this scenario.",
      "Run status COMPLETED is never treated as functional acceptance.",
    ],
  };
}

export function summarizeReport(report) {
  const lines = [`RELIABILITY_EVAL_STATUS=${report.status}`];
  for (const scenario of report.scenarios) {
    lines.push(
      `${scenario.status.padEnd(8)} ${scenario.id} (${scenario.reason})${
        scenario.unmet.length === 0 ? "" : ` unmet=${scenario.unmet.join(",")}`
      }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** @param {{ report: any, outputDir: string, now?: () => Date }} input */
export async function writeReport(input) {
  const now = input.now ?? (() => new Date());
  const directory = assertOutsideRepository(input.outputDir);
  await mkdir(directory, { recursive: true });
  const stamp = now().toISOString().replace(/[:.]/gu, "-");
  const reportPath = path.join(directory, `reliability-eval-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(input.report, null, 2)}\n`, "utf8");
  const summaryPath = path.join(directory, `reliability-eval-${stamp}.txt`);
  await writeFile(summaryPath, summarizeReport(input.report), "utf8");
  return { reportPath, summaryPath };
}

const EXIT_CODES = Object.freeze({ PASS: 0, FAIL: 1, BLOCKED: 3, NOT_RUN: 4 });

async function main(argv) {
  let options;
  try {
    options = parseEvalArguments(argv);
  } catch (error) {
    if (error instanceof EvalUsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  assertOutsideRepository(options.outputDir);
  assertOutsideRepository(options.workspaceRoot);
  const report = await runEvaluation({ options });
  const { reportPath, summaryPath } = await writeReport({ report, outputDir: options.outputDir });
  process.stdout.write(summarizeReport(report));
  process.stdout.write(
    `RELIABILITY_EVAL_REPORT=${reportPath}\nRELIABILITY_EVAL_SUMMARY=${summaryPath}\n`,
  );
  return EXIT_CODES[report.status] ?? 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
