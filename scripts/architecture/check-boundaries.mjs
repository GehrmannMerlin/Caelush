/**
 * Caelush Architecture V2 boundaries checker.
 *
 * Modes
 * -----
 *   node scripts/architecture/check-boundaries.mjs
 *     Read-only. Fails on a NEW violation and on a STALE baseline entry.
 *
 *   node scripts/architecture/check-boundaries.mjs --verify-baseline
 *     Read-only. Additionally fails when the checked-in baseline differs from
 *     the deterministic baseline for the current checkout.
 *
 *   node scripts/architecture/check-boundaries.mjs --write-baseline
 *     Explicit, manual baseline regeneration. Refused whenever `CI` is truthy.
 *
 * This entry point is the only sanctioned consumer of the rule engine. It never
 * mutates any file other than `legacy-import-baseline.json`, and only when
 * `--write-baseline` is passed explicitly.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { scanWorkspace } from "./scan-workspace.mjs";
import { DEPENDENCY_RULES, findRule, RULE_IDS, V2_ALLOWED_DEPENDENCIES } from "./v2-rules.mjs";

const execFileAsync = promisify(execFile);

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
export const DEFAULT_BASELINE_PATH = path.join(SCRIPT_DIRECTORY, "legacy-import-baseline.json");

export const BASELINE_SCHEMA_VERSION = 1;
export const BASELINE_GENERATOR = "scripts/architecture/check-boundaries.mjs";
export const UNKNOWN_HEAD = "0000000000000000000000000000000000000000";
export const UNKNOWN_HEAD_DATE = "1970-01-01T00:00:00.000Z";

/**
 * @typedef {{
 *   kind: "source-import",
 *   sourcePackage: string,
 *   sourcePath: string,
 *   targetPackage: string,
 *   rule: string,
 *   specifier: string,
 * }} SourceBaselineEntry
 *
 * @typedef {{
 *   kind: "package-manifest",
 *   sourcePackage: string,
 *   sourcePath: string,
 *   targetPackage: string,
 *   rule: string,
 *   specifier: string,
 *   dependencyField: string,
 * }} ManifestBaselineEntry
 *
 * @typedef {SourceBaselineEntry | ManifestBaselineEntry} BaselineEntry
 */

/**
 * A baselined dependency edge is identified by the dependency-edge tuple only.
 * Line numbers, columns, occurrence counts, and raw deep specifiers are
 * deliberately excluded so that ordinary editing, adding a second import, or
 * switching to a deep subpath never churns the frozen baseline.
 *
 * @param {BaselineEntry} entry
 * @returns {string}
 */
export function baselineKey(entry) {
  return [
    entry.kind,
    entry.sourcePackage,
    entry.sourcePath,
    entry.targetPackage,
    entry.rule,
    entry.dependencyField ?? "",
  ].join("\u0000");
}

const BASELINE_ENTRY_COMPARATOR = (left, right) =>
  left.kind.localeCompare(right.kind) ||
  left.sourcePackage.localeCompare(right.sourcePackage) ||
  left.sourcePath.localeCompare(right.sourcePath) ||
  left.targetPackage.localeCompare(right.targetPackage) ||
  left.rule.localeCompare(right.rule) ||
  (left.dependencyField ?? "").localeCompare(right.dependencyField ?? "");

/**
 * Serialize an object as a single-line JSON object with a deterministic key
 * order, so a baseline entry occupies exactly one reviewable line.
 *
 * @param {Record<string, unknown>} record
 * @param {string} [indent]
 * @returns {string}
 */
function stringifyCompactRecord(record, indent = "") {
  const fields = Object.entries(record).map(
    ([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{ ${fields.join(", ")} }`.replace(/^\{/, `${indent}{`);
}

/**
 * Deterministically sort baseline entries.
 *
 * @param {BaselineEntry[]} entries
 * @returns {BaselineEntry[]}
 */
export function sortBaselineEntries(entries) {
  return [...entries].sort(BASELINE_ENTRY_COMPARATOR);
}

/**
 * Evaluate every scanned edge against the frozen Architecture V2 rule matrix.
 *
 * @param {Awaited<ReturnType<typeof scanWorkspace>>} scan
 * @returns {{
 *   violations: (BaselineEntry & { line: number, column: number, detail: Record<string, unknown> })[],
 *   sourceEdges: number,
 *   manifestEdges: number,
 * }}
 */
export function evaluateScan(scan) {
  /** @type {(BaselineEntry & { line: number, column: number, detail: Record<string, unknown> })[]} */
  const violations = [];

  for (const edge of scan.sourceEdges) {
    const matched = findRule("source-import", edge.sourcePackage, edge.targetPackage);
    if (!matched) {
      continue;
    }
    violations.push({
      kind: "source-import",
      sourcePackage: edge.sourcePackage,
      sourcePath: edge.sourcePath,
      targetPackage: edge.targetPackage,
      rule: matched.id,
      specifier: edge.normalizedSpecifier,
      line: edge.line,
      column: edge.column,
      detail: {
        rawSpecifier: edge.specifier,
        occurrenceCount: edge.occurrenceCount,
        importKind: edge.importKinds[0],
        importKinds: edge.importKinds,
      },
    });
  }

  for (const edge of scan.manifestEdges) {
    const matched = findRule("package-manifest", edge.sourcePackage, edge.targetPackage);
    if (!matched) {
      continue;
    }
    violations.push({
      kind: "package-manifest",
      sourcePackage: edge.sourcePackage,
      sourcePath: edge.sourcePath,
      targetPackage: edge.targetPackage,
      rule: matched.id,
      specifier: edge.normalizedSpecifier,
      dependencyField: edge.dependencyField,
      line: edge.line,
      column: edge.column,
      detail: {
        dependencyField: edge.dependencyField,
      },
    });
  }

  violations.sort(
    (left, right) =>
      BASELINE_ENTRY_COMPARATOR(left, right) ||
      left.line - right.line ||
      left.column - right.column,
  );

  return {
    violations,
    sourceEdges: scan.sourceEdges.length,
    manifestEdges: scan.manifestEdges.length,
  };
}

/**
 * Compare the evaluated violations against the checked-in baseline.
 *
 * @param {{ violations: (BaselineEntry & { line: number, column: number, detail: Record<string, unknown> })[] }} evaluated
 * @param {BaselineEntry[]} baselineEntries
 * @returns {{
 *   matched: (BaselineEntry & { line: number, column: number, detail: Record<string, unknown> })[],
 *   newViolations: (BaselineEntry & { line: number, column: number, detail: Record<string, unknown> })[],
 *   staleEntries: BaselineEntry[],
 *   duplicateBaselineKeys: string[],
 * }}
 */
export function compareWithBaseline(evaluated, baselineEntries) {
  const seenBaselineKeys = new Set();
  /** @type {string[]} */
  const duplicateBaselineKeys = [];
  const baselineByKey = new Map();

  for (const entry of baselineEntries) {
    const key = baselineKey(entry);
    if (seenBaselineKeys.has(key)) {
      duplicateBaselineKeys.push(key);
      continue;
    }
    seenBaselineKeys.add(key);
    baselineByKey.set(key, entry);
  }

  /** @type {typeof evaluated.violations} */
  const matched = [];
  /** @type {typeof evaluated.violations} */
  const newViolations = [];
  const matchedKeys = new Set();

  for (const violation of evaluated.violations) {
    const key = baselineKey(violation);
    if (baselineByKey.has(key)) {
      matched.push(violation);
      matchedKeys.add(key);
    } else {
      newViolations.push(violation);
    }
  }

  const staleEntries = [...baselineByKey.entries()]
    .filter(([key]) => !matchedKeys.has(key))
    .map(([, entry]) => entry)
    .sort(BASELINE_ENTRY_COMPARATOR);

  return {
    matched,
    newViolations,
    staleEntries,
    duplicateBaselineKeys: duplicateBaselineKeys.sort(),
  };
}

/**
 * Build the deterministic baseline document for a scan.
 *
 * @param {{ violations: (BaselineEntry & { line: number, column: number, detail: Record<string, unknown> })[] }} evaluated
 * @param {{ gitHead: string, generatedAt: string }} context
 * @returns {object}
 */
export function buildBaselineDocument(evaluated, context) {
  const entries = sortBaselineEntries(
    evaluated.violations.map((violation) =>
      violation.kind === "package-manifest"
        ? {
            kind: violation.kind,
            sourcePackage: violation.sourcePackage,
            sourcePath: violation.sourcePath,
            targetPackage: violation.targetPackage,
            rule: violation.rule,
            specifier: violation.specifier,
            dependencyField: violation.dependencyField,
          }
        : {
            kind: violation.kind,
            sourcePackage: violation.sourcePackage,
            sourcePath: violation.sourcePath,
            targetPackage: violation.targetPackage,
            rule: violation.rule,
            specifier: violation.specifier,
          },
    ),
  );

  const byRule = countBy(entries, (entry) => entry.rule);
  const bySource = countBy(entries, (entry) => entry.sourcePackage);

  return {
    $schema: "./legacy-import-baseline.schema.md",
    schemaVersion: BASELINE_SCHEMA_VERSION,
    generator: BASELINE_GENERATOR,
    generatedFromHead: context.gitHead,
    generatedAt: context.generatedAt,
    matchingSemantics:
      "An entry matches when kind, sourcePackage, sourcePath, targetPackage, rule and dependencyField are identical. Lines, columns, occurrence counts and deep subpaths are excluded so ordinary edits do not churn this file.",
    normalization:
      "Specifiers are normalized to the owning package: @caelush/agent, @caelush/agent/context and @caelush/agent/tools/foo all normalize to @caelush/agent.",
    ratchet:
      "This file may only shrink. A violation that is not listed here fails the check as NEW_VIOLATION. A listed entry with no matching violation fails the check as STALE_BASELINE_ENTRY.",
    entryCount: entries.length,
    countsByRule: byRule,
    countsBySourcePackage: bySource,
    entries,
  };
}

/**
 * Render a baseline document in a stable, reviewable, one-entry-per-line form.
 *
 * @param {ReturnType<typeof buildBaselineDocument>} document
 * @returns {string}
 */
export function renderBaselineDocument(document) {
  const { entries, ...header } = document;
  const headerLines = Object.entries(header).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`,
  );
  const entryLines = entries.map((entry) => `${stringifyCompactRecord(entry, "    ")},`);

  if (entryLines.length > 0) {
    entryLines[entryLines.length - 1] = entryLines[entryLines.length - 1].replace(/,$/u, "");
  }

  return `${[
    "{",
    ...headerLines,
    ...(entryLines.length === 0 ? ['  "entries": []'] : ['  "entries": [', ...entryLines, "  ]"]),
    "}",
  ].join("\n")}\n`;
}

/**
 * Canonical, formatting-independent form of a baseline document. Two documents
 * with the same entries and the same descriptive metadata always produce the
 * same canonical string, regardless of whitespace or key order, so baseline
 * drift can be detected without being coupled to the renderer.
 *
 * @param {object} document
 * @returns {string}
 */
export function canonicalizeBaselineDocument(document) {
  const entries = sortBaselineEntries(parseBaselineDocument(document));
  const metadata = Object.fromEntries(
    Object.entries(document)
      .filter(([key]) => key !== "entries")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify(metadata)}\n${JSON.stringify(entries)}`;
}

/**
 * @param {BaselineEntry[]} entries
 * @param {(entry: BaselineEntry) => string} keySelector
 * @returns {Record<string, number>}
 */
function countBy(entries, keySelector) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const entry of entries) {
    const key = keySelector(entry);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {BaselineEntry[]}
 */
export function parseBaselineDocument(value, label = "baseline") {
  if (typeof value !== "object" || value === null || !("entries" in value)) {
    throw new Error(`${label} is not a valid baseline document: missing "entries" array`);
  }
  const entries = /** @type {{ entries: unknown }} */ (value).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${label} is not a valid baseline document: "entries" is not an array`);
  }

  return entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${label} entry ${index} is not an object`);
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    for (const field of ["kind", "sourcePackage", "sourcePath", "targetPackage", "rule"]) {
      if (typeof record[field] !== "string" || record[field] === "") {
        throw new Error(`${label} entry ${index} is missing string field "${field}"`);
      }
    }
    if (record.kind !== "source-import" && record.kind !== "package-manifest") {
      throw new Error(`${label} entry ${index} has unknown kind "${String(record.kind)}"`);
    }
    if (typeof record.specifier !== "string" || record.specifier === "") {
      throw new Error(`${label} entry ${index} is missing string field "specifier"`);
    }
    if (record.kind === "package-manifest" && typeof record.dependencyField !== "string") {
      throw new Error(`${label} entry ${index} is a manifest entry without "dependencyField"`);
    }

    return /** @type {BaselineEntry} */ ({
      kind: record.kind,
      sourcePackage: record.sourcePackage,
      sourcePath: record.sourcePath,
      targetPackage: record.targetPackage,
      rule: record.rule,
      specifier: record.specifier,
      ...(record.kind === "package-manifest"
        ? { dependencyField: /** @type {string} */ (record.dependencyField) }
        : {}),
    });
  });
}

/**
 * @param {BaselineEntry} entry
 * @param {Map<string, { line: number, column: number, detail: Record<string, unknown> }>} locationIndex
 * @returns {string}
 */
export function formatViolation(entry, locationIndex) {
  const location = locationIndex.get(baselineKey(entry));
  const lines = ["Architecture V2 violation", "", "Source:", entry.sourcePath];

  if (location !== undefined) {
    lines.push("", "Location:", `${entry.sourcePath}:${location.line}:${location.column}`);
  }

  lines.push(
    "",
    "Source package:",
    `@caelush/${entry.sourcePackage}`,
    "",
    "Illegal dependency:",
    `@caelush/${entry.targetPackage}`,
    "",
    "Rule:",
    entry.rule,
    "",
    "Import:",
    entry.specifier,
    "",
    "Kind:",
    entry.kind,
  );

  if (entry.kind === "package-manifest") {
    lines.push("", "Dependency field:", entry.dependencyField);
  }

  lines.push("", "Status:", "NEW_VIOLATION");
  return lines.join("\n");
}

/**
 * @param {BaselineEntry} entry
 * @returns {string}
 */
export function formatStaleEntry(entry) {
  return [
    "Architecture V2 stale baseline entry",
    "",
    "Source:",
    entry.sourcePath,
    "",
    "Source package:",
    `@caelush/${entry.sourcePackage}`,
    "",
    "Dependency:",
    `@caelush/${entry.targetPackage}`,
    "",
    "Rule:",
    entry.rule,
    "",
    "Kind:",
    entry.kind,
    "",
    "Action:",
    "remove resolved violation from",
    "scripts/architecture/legacy-import-baseline.json",
  ].join("\n");
}

/**
 * Resolve the deterministic provenance recorded in a baseline document.
 *
 * Both fields must be reproducible on re-generation, otherwise the baseline
 * would churn on every `--write-baseline` and `--verify-baseline` could never be
 * trusted. The caller may override either value; otherwise they are read from
 * the repository scan root and fall back to fixed sentinels in a non-git
 * workspace.
 *
 * `root` is used instead of the current working directory so a fixture scan
 * never inherits the real repository's git identity.
 *
 * @param {string} root
 * @param {{ gitHead?: string, gitHeadDate?: string }} options
 * @returns {Promise<{ gitHead: string, generatedAt: string }>}
 */
async function resolveProvenance(root, options) {
  return {
    gitHead: options.gitHead ?? (await readGitValue(root, ["rev-parse", "HEAD"], UNKNOWN_HEAD)),
    generatedAt:
      options.gitHeadDate ??
      (await readGitValue(root, ["log", "-1", "--format=%cI"], UNKNOWN_HEAD_DATE)),
  };
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {string} fallback
 * @returns {Promise<string>}
 */
async function readGitValue(root, args, fallback) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    const value = stdout.trim();
    return value === "" ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Decide whether writing the evaluated violations would grow the checked-in
 * baseline. A missing or unreadable baseline counts as growth, because writing
 * one would introduce entries that were not reviewed and committed.
 *
 * @param {string} baselinePath
 * @param {{ violations: (BaselineEntry & { line: number, column: number })[] }} evaluated
 * @returns {Promise<boolean>}
 */
async function baselineWouldGrow(baselinePath, evaluated) {
  let existing;
  try {
    existing = parseBaselineDocument(
      JSON.parse(await readFile(baselinePath, "utf8")),
      path.basename(baselinePath),
    );
  } catch {
    return evaluated.violations.length > 0;
  }

  const existingKeys = new Set(existing.map((entry) => baselineKey(entry)));
  return evaluated.violations.some((violation) => !existingKeys.has(baselineKey(violation)));
}

/**
 * Run the full boundary check.
 *
 * @param {{
 *   root?: string,
 *   baselinePath?: string,
 *   writeBaseline?: boolean,
 *   verifyBaseline?: boolean,
 *   gitHead?: string,
 *   gitHeadDate?: string,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 * @returns {Promise<{
 *   exitCode: number,
 *   output: string,
 *   summary: Record<string, unknown>,
 * }>}
 */
export async function runBoundaryCheck(options = {}) {
  const root = options.root ?? DEFAULT_REPOSITORY_ROOT;
  const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH;
  const env = options.env ?? process.env;
  const writeBaseline = options.writeBaseline === true;
  const verifyBaseline = options.verifyBaseline === true;

  const scan = await scanWorkspace(root);
  const evaluated = evaluateScan(scan);

  const unknownRules = evaluated.violations
    .filter((violation) => !RULE_IDS.includes(violation.rule))
    .map((violation) => violation.rule);
  if (unknownRules.length > 0) {
    throw new Error(`Evaluated violations reference unknown rules: ${unknownRules.join(", ")}`);
  }

  const provenance = await resolveProvenance(root, options);
  const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "false";

  if (writeBaseline && ci && (await baselineWouldGrow(baselinePath, evaluated))) {
    return {
      exitCode: 1,
      output: [
        "Architecture V2 baseline cannot be regenerated in CI",
        "",
        "Reason:",
        "the regenerated baseline would add entries that are not in the checked-in baseline",
        "",
        "Action:",
        "run the command locally, review the diff, and commit it as a deliberate architecture decision",
      ].join("\n"),
      summary: {
        refused: "ci-baseline-growth",
        violations: evaluated.violations.length,
      },
    };
  }

  if (writeBaseline) {
    const document = buildBaselineDocument(evaluated, provenance);
    await writeFile(baselinePath, renderBaselineDocument(document), "utf8");
    return {
      exitCode: 0,
      output: [
        "Architecture V2 baseline written",
        "",
        "File:",
        path.relative(root, baselinePath).split(path.sep).join("/"),
        "",
        "Entries:",
        String(document.entryCount),
      ].join("\n"),
      summary: {
        written: true,
        entries: document.entryCount,
        violations: evaluated.violations.length,
      },
    };
  }

  /** @type {BaselineEntry[]} */
  let baselineEntries;
  let baselineRaw;
  try {
    baselineRaw = await readFile(baselinePath, "utf8");
  } catch (error) {
    return {
      exitCode: 1,
      output: [
        "Architecture V2 baseline missing",
        "",
        "Expected:",
        path.relative(root, baselinePath).split(path.sep).join("/"),
        "",
        "Action:",
        "run `node scripts/architecture/check-boundaries.mjs --write-baseline` locally and commit the reviewed baseline",
      ].join("\n"),
      summary: { error: String(error) },
    };
  }

  baselineEntries = parseBaselineDocument(
    JSON.parse(baselineRaw),
    path.relative(root, baselinePath),
  );

  const comparison = compareWithBaseline(evaluated, baselineEntries);
  const locationIndex = new Map(
    evaluated.violations.map((violation) => [
      baselineKey(violation),
      { line: violation.line, column: violation.column, detail: violation.detail },
    ]),
  );

  /** @type {string[]} */
  const problems = [];

  if (comparison.newViolations.length > 0) {
    problems.push(
      ...comparison.newViolations.map((violation) =>
        formatViolation(/** @type {BaselineEntry} */ (violation), locationIndex),
      ),
    );
  }

  if (comparison.staleEntries.length > 0) {
    problems.push(...comparison.staleEntries.map((entry) => formatStaleEntry(entry)));
  }

  if (comparison.duplicateBaselineKeys.length > 0) {
    problems.push(
      [
        "Architecture V2 duplicate baseline entries",
        "",
        "Count:",
        String(comparison.duplicateBaselineKeys.length),
        "",
        "Action:",
        "remove duplicate entries from",
        "scripts/architecture/legacy-import-baseline.json",
      ].join("\n"),
    );
  }

  let baselineDrift = false;
  let baselineDriftDetail = "";
  if (verifyBaseline) {
    const parsedDocument = JSON.parse(baselineRaw);
    const currentDocument = buildBaselineDocument(evaluated, {
      gitHead:
        typeof parsedDocument.generatedFromHead === "string"
          ? parsedDocument.generatedFromHead
          : UNKNOWN_HEAD,
      generatedAt:
        typeof parsedDocument.generatedAt === "string"
          ? parsedDocument.generatedAt
          : UNKNOWN_HEAD_DATE,
    });
    baselineDrift =
      canonicalizeBaselineDocument(currentDocument) !==
      canonicalizeBaselineDocument(parsedDocument);

    if (baselineDrift) {
      const expectedByKey = new Map(
        currentDocument.entries.map((entry) => [baselineKey(entry), entry]),
      );
      const actualByKey = new Map(baselineEntries.map((entry) => [baselineKey(entry), entry]));
      const missingFromFile = [...expectedByKey.keys()].filter((key) => !actualByKey.has(key));
      const extraInFile = [...actualByKey.keys()].filter((key) => !expectedByKey.has(key));
      baselineDriftDetail = [
        `entries expected:   ${String(currentDocument.entries.length)}`,
        `entries present:    ${String(baselineEntries.length)}`,
        `missing from file:  ${String(missingFromFile.length)}`,
        `unexpected in file: ${String(extraInFile.length)}`,
        "Whitespace, key order and entry order are normalized before comparison; only entry content counts as drift.",
      ].join("\n");
    }
  }

  const summary = {
    projects: scan.projects.length,
    sourceFiles: scan.sourceFileCount,
    sourceImports: scan.sourceImportCount,
    sourceEdges: evaluated.sourceEdges,
    manifestEdges: evaluated.manifestEdges,
    baselineEntries: baselineEntries.length,
    matchedLegacyViolations: comparison.matched.length,
    newViolations: comparison.newViolations.length,
    staleBaselineEntries: comparison.staleEntries.length,
    duplicateBaselineEntries: comparison.duplicateBaselineKeys.length,
    unknownCaelushSpecifiers: scan.unknownCaelushSpecifiers,
    violationsByRule: countBy(evaluated.violations, (violation) => violation.rule),
    violationsBySourcePackage: countBy(
      evaluated.violations,
      (violation) => violation.sourcePackage,
    ),
    legacyViolationsByRule: countBy(comparison.matched, (violation) => violation.rule),
    legacyViolationsBySourcePackage: countBy(
      comparison.matched,
      (violation) => violation.sourcePackage,
    ),
    newViolationsByRule: countBy(comparison.newViolations, (violation) => violation.rule),
    staleBaselineEntriesBySourcePackage: countBy(
      comparison.staleEntries,
      (entry) => entry.sourcePackage,
    ),
    baselineDrift,
  };

  if (baselineDrift) {
    return {
      exitCode: 1,
      output: [
        "Architecture V2 baseline drift detected",
        "",
        "File:",
        "scripts/architecture/legacy-import-baseline.json",
        "",
        "Detail:",
        baselineDriftDetail,
        "",
        "Action:",
        "regenerate the baseline explicitly with `--write-baseline` and commit the reviewed diff",
        "",
        formatSummary(summary),
      ].join("\n"),
      summary,
    };
  }

  if (problems.length > 0) {
    return {
      exitCode: 1,
      output: [
        `Architecture V2 check failed: ${comparison.newViolations.length} new violation(s), ${comparison.staleEntries.length} stale baseline entry(ies)`,
        "",
        problems.join("\n\n---\n\n"),
        "",
        "---",
        "",
        formatSummary(summary),
      ].join("\n"),
      summary,
    };
  }

  return {
    exitCode: 0,
    output: [
      "Architecture V2 boundaries PASS",
      "",
      formatSummary(summary),
      "",
      "Meaning:",
      "no NEW violation and no STALE baseline entry. Legacy violations listed in the baseline remain frozen until their migration phase removes them.",
    ].join("\n"),
    summary,
  };
}

/**
 * @param {Record<string, unknown>} summary
 * @returns {string}
 */
export function formatSummary(summary) {
  const lines = [
    `workspace projects:        ${String(summary.projects)}`,
    `scanned source files:      ${String(summary.sourceFiles)}`,
    `parsed module specifiers:  ${String(summary.sourceImports)}`,
    `workspace source edges:    ${String(summary.sourceEdges)}`,
    `workspace manifest edges:  ${String(summary.manifestEdges)}`,
    `legacy violations frozen:  ${String(summary.matchedLegacyViolations)}`,
    `baseline entries:          ${String(summary.baselineEntries)}`,
    `new violations:            ${String(summary.newViolations)}`,
    `stale baseline entries:    ${String(summary.staleBaselineEntries)}`,
  ];
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 */
function parseArguments(argv) {
  const options = {
    writeBaseline: false,
    verifyBaseline: false,
    json: false,
    report: /** @type {string | undefined} */ (undefined),
    root: DEFAULT_REPOSITORY_ROOT,
    baselinePath: DEFAULT_BASELINE_PATH,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--write-baseline":
        options.writeBaseline = true;
        break;
      case "--verify-baseline":
        options.verifyBaseline = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--root": {
        const value = argv[index + 1];
        if (!value) throw new Error("--root requires a path argument");
        options.root = path.resolve(value);
        index += 1;
        break;
      }
      case "--baseline": {
        const value = argv[index + 1];
        if (!value) throw new Error("--baseline requires a path argument");
        options.baselinePath = path.resolve(value);
        index += 1;
        break;
      }
      case "--report": {
        const value = argv[index + 1];
        if (!value) throw new Error("--report requires a path argument");
        options.report = path.resolve(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

const HELP = `Caelush Architecture V2 boundaries checker

Usage:
  node scripts/architecture/check-boundaries.mjs [options]

Options:
  --verify-baseline   Also fail when the checked-in baseline is not the
                      deterministic baseline for the current checkout.
  --write-baseline    Explicitly regenerate scripts/architecture/legacy-import-baseline.json.
                      Refused in CI whenever the regenerated baseline would ADD
                      entries that are not in the checked-in baseline.
  --json              Print the machine-readable summary as JSON.
  --report <path>     Write the machine-readable summary to a file.
  --root <path>       Repository root. Defaults to the repository containing this script.
  --baseline <path>   Baseline file. Defaults to scripts/architecture/legacy-import-baseline.json.
  --help, -h          Print this message.

Exit codes:
  0  no NEW violation, no STALE baseline entry
  1  at least one NEW violation, at least one STALE baseline entry,
     a missing/invalid baseline, or a refused write

Frozen Architecture V2 rule count: ${DEPENDENCY_RULES.length}
Architecture V2 allowed direction: ${JSON.stringify(V2_ALLOWED_DEPENDENCIES)}
`;

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const result = await runBoundaryCheck({
    root: options.root,
    baselinePath: options.baselinePath,
    writeBaseline: options.writeBaseline,
    verifyBaseline: options.verifyBaseline,
  });

  process.stdout.write(
    options.json ? `${JSON.stringify(result.summary, null, 2)}\n` : `${result.output}\n`,
  );

  if (options.report !== undefined) {
    await writeFile(options.report, `${JSON.stringify(result.summary, null, 2)}\n`, "utf8");
  }

  process.exitCode = result.exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  await main();
}
