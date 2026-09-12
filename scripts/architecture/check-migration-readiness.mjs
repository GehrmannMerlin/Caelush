/**
 * Caelush Architecture V2 migration readiness gate.
 *
 * Answers one question: **is this repository ready to begin real subsystem
 * migration?** It does not re-implement the architecture scanner. It reuses
 *
 *   scripts/architecture/v2-rules.mjs          the frozen graph and rule set
 *   scripts/architecture/v2-migration-map.mjs  where every legacy package goes
 *   scripts/architecture/scan-workspace.mjs    the real dependency graph
 *   scripts/architecture/legacy-import-baseline.json  the frozen migration debt
 *
 * and adds only the readiness conditions that none of them express on their own.
 *
 * Every count is computed from the live scan. Nothing is hard-coded, so this gate
 * keeps working as the baseline shrinks from 33 to 20 to 0 during migration: it
 * asserts that the *remaining* debt is legitimate migration debt, not that the
 * debt has a particular size.
 *
 * Exit codes:
 *   0  READY
 *   1  NOT_READY
 *   2  usage error
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { scanWorkspace } from "./scan-workspace.mjs";
import {
  DEPENDENCY_RULES,
  isAllowedTargetEdge,
  packageRole,
  RULE_SET_VERSION,
  V2_ALLOWED_DEPENDENCIES,
  V2_LEGACY_PACKAGES,
  V2_TARGET_PACKAGES,
} from "./v2-rules.mjs";
import { LEGACY_MIGRATION_MAP, MIGRATION_DELETE, migrationEntryFor } from "./v2-migration-map.mjs";

const execFileAsync = promisify(execFile);

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
export const DEFAULT_BASELINE_PATH = path.join(SCRIPT_DIRECTORY, "legacy-import-baseline.json");

/** Packages Phase 1A created as empty skeletons that must stay dependency-free. */
export const V2_SKELETON_PACKAGES = ["ai", "agent", "coding-agent"];

/** The only baseline debt class that is legitimate migration debt. */
export const MIGRATION_DEBT_CLASSES = ["target-to-legacy", "package-manifest"];

/** The only baseline entry kind that represents a dependency edge. */
export const MIGRATION_DEBT_ENTRY_KINDS = ["source-import", "package-manifest"];

/** Violation classes that mean the architecture is already broken, not mid-migration. */
export const NON_MIGRATION_DEBT_CLASSES = [
  "target-graph",
  "target-to-host",
  "host-boundary",
  "private-import",
  "cross-workspace-relative-import",
];

/** Every repository path a clean checkout must contain for this gate to run. */
export const ARCHITECTURE_ENTRY_POINTS = [
  "scripts/architecture/v2-rules.mjs",
  "scripts/architecture/v2-migration-map.mjs",
  "scripts/architecture/scan-workspace.mjs",
  "scripts/architecture/check-boundaries.mjs",
  "scripts/architecture/check-migration-readiness.mjs",
  "scripts/architecture/legacy-import-baseline.json",
];

/** Root package.json scripts the CI gate depends on. */
export const REQUIRED_ROOT_SCRIPTS = [
  "check:architecture",
  "check:architecture:verify",
  "check:architecture:readiness",
  "check:architecture:ci",
];

/**
 * @typedef {{ id: string, title: string, ok: boolean, detail: string, findings: string[] }} ReadinessCondition
 */

/**
 * Execute an architecture entry point as a real child process.
 *
 * The child is launched with `process.execPath` (the Node binary running this
 * gate) rather than through a `pnpm` shim. The shim is a shell script on POSIX and
 * a `.cmd` on Windows, so `execFile("pnpm", …)` without a shell only resolves on
 * POSIX, and adding `shell: true` would emit a Node deprecation warning about
 * unescaped arguments. Launching the `.mjs` entry point with the current Node
 * binary proves the same thing — the gate command exists and exits 0 — and behaves
 * identically on every platform.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function runEntryPoint(root, args) {
  await execFileAsync(process.execPath, args, { cwd: root, encoding: "utf8" });
}

/**
 * @param {string} root
 * @returns {Promise<{ content: string, missing: boolean }>}
 */
async function readRepositoryFile(root, relativePath) {
  try {
    return {
      content: await readFile(path.join(root, ...relativePath.split("/")), "utf8"),
      missing: false,
    };
  } catch {
    return { content: "", missing: true };
  }
}

/**
 * @param {string} root
 * @returns {Promise<string>}
 */
async function readHead(root) {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      });
      const value = stdout.trim();
      if (value !== "") return value;
    } catch {
      // retried below
    }
  }
  return "unknown";
}

/** Static contract: the frozen allowlist must equal the derivation input and grant nothing implicit. */
export function checkStaticContract() {
  /** @type {string[]} */
  const findings = [];
  const staticallyKnown = V2_TARGET_PACKAGES.filter((target) =>
    Object.prototype.hasOwnProperty.call(V2_ALLOWED_DEPENDENCIES, target),
  );
  if (staticallyKnown.length !== V2_TARGET_PACKAGES.length) {
    const missing = V2_TARGET_PACKAGES.filter((target) => !staticallyKnown.includes(target));
    findings.push(`allowlist is missing an entry for: ${missing.join(", ")}`);
  }

  for (const [from, allowed] of Object.entries(V2_ALLOWED_DEPENDENCIES)) {
    for (const to of allowed) {
      if (packageRole(to) !== "target") {
        findings.push(`allowlist entry ${from} -> ${to} targets a non-target package`);
      }
      if (from === to) {
        findings.push(`allowlist entry ${from} -> ${from} is a self dependency`);
      }
      if (!isAllowedTargetEdge(from, to)) {
        findings.push(`allowlist says ${from} -> ${to} is allowed but the rule model forbids it`);
      }
    }
  }
  return findings;
}

/**
 * Run the readiness gate.
 *
 * @param {{ root?: string, baselinePath?: string, head?: string, runCommandChecks?: boolean }} [options]
 * @returns {Promise<{
 *   ready: boolean,
 *   exitCode: number,
 *   output: string,
 *   conditions: ReadinessCondition[],
 *   summary: Record<string, unknown>,
 * }>}
 */
export async function runMigrationReadinessCheck(options = {}) {
  const root = options.root ?? DEFAULT_REPOSITORY_ROOT;
  const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH;
  const runCommandChecks = options.runCommandChecks !== false;

  const scan = await scanWorkspace(root, { includeTests: true });
  const projectIdentities = new Set(scan.projects.map((project) => project.identity));
  const projectByIdentity = new Map(scan.projects.map((project) => [project.identity, project]));

  const baselineRaw = await readFile(baselinePath, "utf8");
  const baseline = JSON.parse(baselineRaw);
  /** @type {{ kind: string, rule: string, edgeClass: string, sourcePackage: string, sourcePath: string, targetPackage: string, specifier: string }[]} */
  const baselineEntries = baseline.entries;

  const head = options.head ?? (await readHead(root));

  /** @type {ReadinessCondition[]} */
  const conditions = [];

  // 14.1 Target package inventory -------------------------------------------------
  {
    const findings = [];
    for (const target of V2_TARGET_PACKAGES) {
      const project = projectByIdentity.get(target);
      if (project === undefined) {
        findings.push(`@caelush/${target} does not exist in the workspace`);
        continue;
      }
      if (project.identity !== target) {
        findings.push(`@caelush/${target} has mismatched identity "${project.identity}"`);
      }
      const expectedDirectory = `packages/${target}`;
      if (project.relativeDirectory !== expectedDirectory) {
        findings.push(
          `@caelush/${target} lives at ${project.relativeDirectory}, expected ${expectedDirectory}`,
        );
      }
      if ((project.exportDeclarations ?? []).length === 0) {
        findings.push(`@caelush/${target} declares no package.json exports entry point`);
      }
    }
    conditions.push({
      id: "target-package-inventory",
      title: "Target package inventory",
      ok: findings.length === 0,
      detail: `${V2_TARGET_PACKAGES.filter((target) => projectIdentities.has(target)).length} / ${V2_TARGET_PACKAGES.length}`,
      findings,
    });
  }

  // 14.2 Legacy migration map coverage -------------------------------------------
  {
    const findings = [];
    for (const legacy of V2_LEGACY_PACKAGES) {
      const entry = migrationEntryFor(legacy);
      if (entry === undefined) {
        findings.push(`@caelush/${legacy} has no migration destination`);
        continue;
      }
      if (entry.destinations.length === 0 && !entry.operations.includes(MIGRATION_DELETE)) {
        findings.push(`@caelush/${legacy} has neither a destination nor DELETE`);
      }
      for (const destination of entry.destinations) {
        if (packageRole(destination) === "legacy" || packageRole(destination) === "unknown") {
          findings.push(
            `@caelush/${legacy} maps to "${destination}", which is not a valid destination`,
          );
        }
      }
      for (const guide of entry.splitGuide ?? []) {
        if (
          packageRole(guide.destination) === "legacy" ||
          packageRole(guide.destination) === "unknown"
        ) {
          findings.push(
            `@caelush/${legacy} split guide "${guide.concern}" maps to invalid destination "${guide.destination}"`,
          );
        }
      }
    }
    for (const target of V2_TARGET_PACKAGES) {
      if (migrationEntryFor(target) !== undefined) {
        findings.push(
          `@caelush/${target} is a target package but appears as a legacy migration source`,
        );
      }
    }
    conditions.push({
      id: "legacy-migration-map",
      title: "Legacy migration mappings",
      ok: findings.length === 0,
      detail: `${V2_LEGACY_PACKAGES.filter((legacy) => migrationEntryFor(legacy) !== undefined).length} / ${V2_LEGACY_PACKAGES.length}`,
      findings,
    });
  }

  // 14.3 Baseline debt class ------------------------------------------------------
  {
    const findings = [];
    const classCounts = new Map();
    for (const entry of baselineEntries) {
      const edgeClass = entry.edgeClass ?? entry.kind;
      classCounts.set(edgeClass, (classCounts.get(edgeClass) ?? 0) + 1);
    }
    for (const [edgeClass, count] of classCounts) {
      if (NON_MIGRATION_DEBT_CLASSES.includes(edgeClass)) {
        findings.push(
          `${count} baseline entr${count === 1 ? "y" : "ies"} of class "${edgeClass}" — this is a live architecture violation, not migration debt`,
        );
        continue;
      }
      if (!MIGRATION_DEBT_CLASSES.includes(edgeClass)) {
        findings.push(
          `${count} baseline entr${count === 1 ? "y" : "ies"} of unrecognised class "${edgeClass}"`,
        );
      }
    }
    for (const entry of baselineEntries) {
      if (!MIGRATION_DEBT_ENTRY_KINDS.includes(entry.kind)) {
        findings.push(
          `baseline entry ${entry.sourcePath} has kind "${entry.kind}", which is not dependency debt`,
        );
      }
    }
    conditions.push({
      id: "baseline-debt-class",
      title: "Debt classes",
      ok: findings.length === 0,
      detail: classCounts.size === 0 ? "no frozen debt" : [...classCounts.keys()].sort().join(", "),
      findings,
    });
  }

  // 14.7 Target -> legacy debt is mappable ----------------------------------------
  {
    const findings = [];
    for (const entry of baselineEntries) {
      if (entry.edgeClass !== "target-to-legacy") continue;
      if (migrationEntryFor(entry.targetPackage) === undefined) {
        findings.push(
          `${entry.sourcePath} depends on @caelush/${entry.targetPackage}, which has no migration destination`,
        );
      }
      if (packageRole(entry.sourcePackage) !== "target") {
        findings.push(
          `${entry.sourcePath} is baseline debt but @caelush/${entry.sourcePackage} is not a target package`,
        );
      }
    }
    conditions.push({
      id: "debt-mappable",
      title: "Debt mappable to a destination",
      ok: findings.length === 0,
      detail: `${baselineEntries.filter((entry) => entry.edgeClass === "target-to-legacy").length} target-to-legacy entries checked`,
      findings,
    });
  }

  // 14.4 / 14.5 No new violation and no stale baseline -----------------------------
  let newViolationCount;
  let staleBaselineCount;
  {
    const { evaluateScan, compareWithBaseline, parseBaselineDocument } =
      await import("./check-boundaries.mjs");
    const evaluated = evaluateScan(scan);
    const comparison = compareWithBaseline(
      evaluated,
      parseBaselineDocument(baseline, path.basename(baselinePath)),
    );

    const newFindings = comparison.newViolations.map(
      (violation) =>
        `${violation.sourcePath} — ${violation.rule} (${violation.sourcePackage} -> ${violation.targetPackage})`,
    );
    newViolationCount = newFindings.length;
    conditions.push({
      id: "no-new-violation",
      title: "New violations",
      ok: newFindings.length === 0,
      detail: String(newFindings.length),
      findings: newFindings,
    });

    const staleFindings = comparison.staleEntries.map(
      (entry) => `${entry.sourcePath} — ${entry.rule}: resolved, must be removed from the baseline`,
    );
    staleBaselineCount = staleFindings.length;
    conditions.push({
      id: "no-stale-baseline",
      title: "Stale baseline entries",
      ok: staleFindings.length === 0,
      detail: String(staleFindings.length),
      findings: staleFindings,
    });
  }

  // 14.6 Public boundary health ----------------------------------------------------
  {
    const findings = [];
    for (const violation of scan.privateImports) {
      findings.push(`${violation.sourcePath} — ${violation.rule}: ${violation.specifier}`);
    }
    for (const violation of scan.crossWorkspaceRelativeImports) {
      findings.push(
        `${violation.sourcePath} — ${violation.rule}: ${violation.specifier} (-> ${violation.targetPackage})`,
      );
    }
    conditions.push({
      id: "public-boundary-health",
      title: "Private production imports",
      ok: findings.length === 0,
      detail: `${scan.privateImports.length} private, ${scan.crossWorkspaceRelativeImports.length} cross-workspace`,
      findings,
    });
  }

  // 14.8 V2 skeleton public boundary -----------------------------------------------
  {
    const findings = [];
    for (const skeleton of V2_SKELETON_PACKAGES) {
      const project = projectByIdentity.get(skeleton);
      if (project === undefined) {
        findings.push(`@caelush/${skeleton} skeleton is missing`);
        continue;
      }
      const subpaths = (project.exportDeclarations ?? []).map((declaration) => declaration.subpath);
      if (subpaths.length === 0) {
        findings.push(`@caelush/${skeleton} declares no exports entry point`);
      }
      for (const subpath of subpaths) {
        if (subpath !== ".") {
          findings.push(
            `@caelush/${skeleton} publishes "${subpath}" before any code migrated; keep the surface at "."`,
          );
        }
      }
      for (const dependency of project.manifestDependencies) {
        if (!dependency.name.startsWith("@caelush/")) continue;
        const target = dependency.name.replace("@caelush/", "");
        if (packageRole(target) === "legacy") {
          findings.push(
            `@caelush/${skeleton} declares a legacy dependency ${dependency.name} in ${dependency.field}`,
          );
        }
      }
    }
    conditions.push({
      id: "v2-skeleton-boundary",
      title: "V2 skeleton boundary",
      ok: findings.length === 0,
      detail: `${V2_SKELETON_PACKAGES.length} skeletons checked`,
      findings,
    });
  }

  // Static contract -----------------------------------------------------------------
  {
    const findings = checkStaticContract();
    conditions.push({
      id: "frozen-allowlist",
      title: "Frozen allowlist integrity",
      ok: findings.length === 0,
      detail: `rule set ${RULE_SET_VERSION}, ${DEPENDENCY_RULES.length} rules`,
      findings,
    });
  }

  // 14.9 Architecture script health --------------------------------------------------
  {
    const findings = [];
    for (const entryPoint of ARCHITECTURE_ENTRY_POINTS) {
      const { missing } = await readRepositoryFile(root, entryPoint);
      if (missing) findings.push(`missing entry point ${entryPoint}`);
    }

    const manifestRaw = await readRepositoryFile(root, "package.json");
    if (manifestRaw.missing) {
      findings.push("root package.json is missing");
    } else {
      const scriptRegion = manifestRaw.content.slice(
        manifestRaw.content.indexOf('"scripts"'),
        manifestRaw.content.indexOf('"devDependencies"'),
      );
      for (const script of REQUIRED_ROOT_SCRIPTS) {
        if (!scriptRegion.includes(`"${script}"`)) {
          findings.push(`root package.json has no "${script}" script`);
        }
      }
    }

    const workflow = await readRepositoryFile(root, ".github/workflows/ci.yml");
    if (workflow.missing) {
      findings.push("no .github/workflows/ci.yml, so the architecture gate is not wired into CI");
    } else {
      for (const required of ["check:architecture:ci", "architecture"]) {
        if (!workflow.content.includes(required)) {
          findings.push(`CI workflow does not reference "${required}"`);
        }
      }
    }

    conditions.push({
      id: "architecture-script-health",
      title: "Architecture scripts",
      ok: findings.length === 0,
      detail: `${ARCHITECTURE_ENTRY_POINTS.length} entry points, ${REQUIRED_ROOT_SCRIPTS.length} scripts`,
      findings,
    });
  }

  // CLI health: each gate command must actually run and exit 0.
  if (runCommandChecks) {
    const findings = [];
    const commands = [
      { script: "check:architecture", args: ["scripts/architecture/check-boundaries.mjs"] },
      {
        script: "check:architecture:verify",
        args: ["scripts/architecture/check-boundaries.mjs", "--verify-baseline"],
      },
    ];
    for (const command of commands) {
      try {
        await runEntryPoint(root, command.args);
      } catch (error) {
        const stdout = /** @type {{ stdout?: string }} */ (error).stdout ?? "";
        const firstLine = String(stdout)
          .split("\n")
          .find((line) => line.trim() !== "");
        findings.push(`${command.script} failed: ${firstLine ?? "no output"}`);
      }
    }
    conditions.push({
      id: "architecture-cli-health",
      title: "Architecture CLI health",
      ok: findings.length === 0,
      detail: `${commands.length} entry points executed`,
      findings,
    });
  }

  // Aggregate ------------------------------------------------------------------------
  const failed = conditions.filter((condition) => !condition.ok);
  const ready = failed.length === 0;

  const classCounts = baselineEntries.reduce((counts, entry) => {
    const key = entry.edgeClass ?? entry.kind;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, /** @type {Record<string, number>} */ ({}));

  const summary = {
    head,
    ruleSetVersion: RULE_SET_VERSION,
    ruleCount: DEPENDENCY_RULES.length,
    targetPackages: V2_TARGET_PACKAGES.length,
    targetPackagesPresent: V2_TARGET_PACKAGES.filter((target) => projectIdentities.has(target))
      .length,
    legacyPackages: V2_LEGACY_PACKAGES.length,
    legacyPackagesMapped: V2_LEGACY_PACKAGES.filter(
      (legacy) => migrationEntryFor(legacy) !== undefined,
    ).length,
    migrationMapEntries: LEGACY_MIGRATION_MAP.length,
    baselineEntries: baselineEntries.length,
    baselineClasses: classCounts,
    baselineSourcePackages: baselineEntries.reduce((counts, entry) => {
      counts[entry.sourcePackage] = (counts[entry.sourcePackage] ?? 0) + 1;
      return counts;
    }, /** @type {Record<string, number>} */ ({})),
    baselineDestinations: baselineEntries.reduce((counts, entry) => {
      counts[entry.targetPackage] = (counts[entry.targetPackage] ?? 0) + 1;
      return counts;
    }, /** @type {Record<string, number>} */ ({})),
    privateImports: scan.privateImports.length,
    crossWorkspaceRelativeImports: scan.crossWorkspaceRelativeImports.length,
    testScopeCrossWorkspaceRelativeImports: scan.testCrossWorkspaceRelativeImports.length,
    testScopePrivateImports: scan.testPrivateImports.length,
    newViolations: newViolationCount,
    staleBaselineEntries: staleBaselineCount,
    failedConditions: failed.map((condition) => condition.id),
    ready,
  };

  const lines = [
    "Caelush Architecture V2 Migration Readiness",
    "",
    `Base commit:                        ${head}`,
    `Rule set version:                   ${RULE_SET_VERSION} (${DEPENDENCY_RULES.length} rules)`,
    "",
    "Target packages:",
    `                                    ${summary.targetPackagesPresent} / ${summary.targetPackages}`,
    "",
    "Legacy migration mappings:",
    `                                    ${summary.legacyPackagesMapped} / ${summary.legacyPackages}`,
    "",
    "Frozen migration debt:",
    `                                    ${baselineEntries.length}`,
    "",
    "Debt classes:",
    `                                    ${Object.keys(classCounts).sort().join(", ") || "none"}`,
    "",
    "Debt by source package:",
    `                                    ${formatCounts(summary.baselineSourcePackages)}`,
    "",
    "Debt by legacy destination:",
    `                                    ${formatCounts(summary.baselineDestinations)}`,
    "",
    "Private production imports:",
    `                                    ${scan.privateImports.length}`,
    "",
    "Cross-workspace private imports:",
    `                                    ${scan.crossWorkspaceRelativeImports.length}`,
    "",
    "Diagnostic test-scope crossings (not gating):",
    `                                    ${scan.testCrossWorkspaceRelativeImports.length} relative, ${scan.testPrivateImports.length} private`,
    "",
    "Readiness:",
    `                                    ${ready ? "READY" : "NOT_READY"}`,
  ];

  if (!ready) {
    lines.push("", "Failed conditions:");
    for (const condition of failed) {
      lines.push("", `  [${condition.id}] ${condition.title}`);
      for (const finding of condition.findings) {
        lines.push(`    ${finding}`);
      }
    }
  }

  return {
    ready,
    exitCode: ready ? 0 : 1,
    output: lines.join("\n"),
    conditions,
    summary,
  };
}

/**
 * @param {Record<string, number>} counts
 * @returns {string}
 */
function formatCounts(counts) {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

const HELP = `Caelush Architecture V2 migration readiness gate

Usage:
  node scripts/architecture/check-migration-readiness.mjs [options]

Options:
  --root <path>       Repository root. Defaults to the repository containing this script.
  --baseline <path>   Baseline file. Defaults to scripts/architecture/legacy-import-baseline.json.
  --json              Print the machine-readable summary as JSON.
  --no-command-checks Skip executing the architecture CLI gates.
  --help, -h          Print this message.

Exit codes:
  0  READY
  1  NOT_READY
  2  unknown command-line argument
`;

async function main() {
  const argv = process.argv.slice(2);
  let root = DEFAULT_REPOSITORY_ROOT;
  let baselinePath = DEFAULT_BASELINE_PATH;
  let json = false;
  let runCommandChecks = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(HELP);
      return;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--no-command-checks") {
      runCommandChecks = false;
      continue;
    }
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path argument");
      root = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--baseline") {
      const value = argv[index + 1];
      if (!value) throw new Error("--baseline requires a path argument");
      baselinePath = path.resolve(value);
      index += 1;
      continue;
    }
    process.stderr.write(`Unknown argument: ${argument}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const result = await runMigrationReadinessCheck({ root, baselinePath, runCommandChecks });
  process.stdout.write(
    json ? `${JSON.stringify(result.summary, null, 2)}\n` : `${result.output}\n`,
  );
  process.exitCode = result.exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await main();
}
