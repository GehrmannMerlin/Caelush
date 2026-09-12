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
 *     the deterministic baseline for the current checkout, or when the baseline
 *     was produced by a different rule set version.
 *
 *   node scripts/architecture/check-boundaries.mjs --write-baseline
 *     Explicit, manual baseline regeneration. It never writes a growing baseline
 *     unless the one-time rule-set expansion protocol is satisfied:
 *
 *       --accept-rule-expansion
 *       --baseline-source-commit <sha>
 *
 *     The protocol admits a violation only when HEAD is exactly the given source
 *     commit and every scanned path is committed, so the admitted set is provably
 *     the Phase 1A tree's own debt and nothing added after it. A growing write is
 *     never possible from CI or from an ordinary `--write-baseline`.
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
import {
  DEPENDENCY_RULES,
  findRule,
  PHASE_1A_FINAL_COMMIT,
  PHASE_1A_RULE_SET_VERSION,
  RULE_IDS,
  RULE_SET_VERSION,
  ruleCountsByKind,
} from "./v2-rules.mjs";

const execFileAsync = promisify(execFile);

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
export const DEFAULT_BASELINE_PATH = path.join(SCRIPT_DIRECTORY, "legacy-import-baseline.json");

export const BASELINE_SCHEMA_VERSION = 1;
export const BASELINE_GENERATOR = "scripts/architecture/check-boundaries.mjs";
export const UNKNOWN_HEAD = "0000000000000000000000000000000000000000";
export const UNKNOWN_HEAD_DATE = "1970-01-01T00:00:00.000Z";

/**
 * The exact rule ids Phase 1A shipped, frozen as history.
 *
 * Phase 1A enforced these 80 ids. Phase 1B adds 152 more rules, so a rule id
 * outside this set is a Phase 1B-or-later invention. That distinction is
 * **informational only**: it tells a reviewer how much of the expansion is new
 * rule coverage. It is deliberately NOT an admission criterion, because the
 * violations a new rule discovers on the Phase 1A tree are by definition
 * pre-existing debt — `storage -> core` was already an Architecture V2 violation
 * at the Phase 1A commit; Phase 1A simply had no rule that said so.
 *
 * The admission proof is therefore the commit-pinned scan: expansion is only
 * allowed when HEAD is exactly the baseline source commit, the scanned paths are
 * committed, and the expansion is explicitly requested.
 *
 * @type {readonly string[]}
 */
export const PHASE_1A_FROZEN_RULE_IDS = Object.freeze([
  "AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_CLIENT",
  "AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_CODING_AGENT",
  "AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_DAEMON",
  "AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
  "AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
  "AGENT_MUST_NOT_DEPEND_ON_CLIENT",
  "AGENT_MUST_NOT_DEPEND_ON_CODING_AGENT",
  "AGENT_MUST_NOT_DEPEND_ON_DAEMON",
  "AGENT_MUST_NOT_DEPEND_ON_RUNTIME",
  "AGENT_MUST_NOT_DEPEND_ON_STORAGE",
  "AI_MUST_NOT_DECLARE_DEPENDENCY_ON_AGENT",
  "AI_MUST_NOT_DECLARE_DEPENDENCY_ON_CLIENT",
  "AI_MUST_NOT_DECLARE_DEPENDENCY_ON_CODING_AGENT",
  "AI_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
  "AI_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
  "AI_MUST_NOT_DEPEND_ON_AGENT",
  "AI_MUST_NOT_DEPEND_ON_CLIENT",
  "AI_MUST_NOT_DEPEND_ON_CODING_AGENT",
  "AI_MUST_NOT_DEPEND_ON_RUNTIME",
  "AI_MUST_NOT_DEPEND_ON_STORAGE",
  "CLI_MUST_NOT_DECLARE_DEPENDENCY_ON_AGENT",
  "CLI_MUST_NOT_DECLARE_DEPENDENCY_ON_CODING_AGENT",
  "CLI_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
  "CLI_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
  "CLI_MUST_NOT_DEPEND_ON_AGENT",
  "CLI_MUST_NOT_DEPEND_ON_CODING_AGENT",
  "CLI_MUST_NOT_DEPEND_ON_RUNTIME",
  "CLI_MUST_NOT_DEPEND_ON_STORAGE",
  "CLIENT_MUST_NOT_DECLARE_DEPENDENCY_ON_AGENT",
  "CLIENT_MUST_NOT_DECLARE_DEPENDENCY_ON_CODING_AGENT",
  "CLIENT_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
  "CLIENT_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
  "CLIENT_MUST_NOT_DEPEND_ON_AGENT",
  "CLIENT_MUST_NOT_DEPEND_ON_CODING_AGENT",
  "CLIENT_MUST_NOT_DEPEND_ON_RUNTIME",
  "CLIENT_MUST_NOT_DEPEND_ON_STORAGE",
  "CODING_AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_CLIENT",
  "CODING_AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_DAEMON",
  "CODING_AGENT_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
  "CODING_AGENT_MUST_NOT_DEPEND_ON_CLIENT",
  "CODING_AGENT_MUST_NOT_DEPEND_ON_DAEMON",
  "CODING_AGENT_MUST_NOT_DEPEND_ON_STORAGE",
  "PROTOCOL_MUST_NOT_DECLARE_DEPENDENCY_ON_AGENT",
  "PROTOCOL_MUST_NOT_DECLARE_DEPENDENCY_ON_CLIENT",
  "PROTOCOL_MUST_NOT_DECLARE_DEPENDENCY_ON_CODING_AGENT",
  "PROTOCOL_MUST_NOT_DECLARE_DEPENDENCY_ON_DAEMON",
  "PROTOCOL_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
  "PROTOCOL_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
  "PROTOCOL_MUST_NOT_DEPEND_ON_AGENT",
  "PROTOCOL_MUST_NOT_DEPEND_ON_CLIENT",
  "PROTOCOL_MUST_NOT_DEPEND_ON_CODING_AGENT",
  "PROTOCOL_MUST_NOT_DEPEND_ON_DAEMON",
  "PROTOCOL_MUST_NOT_DEPEND_ON_RUNTIME",
  "PROTOCOL_MUST_NOT_DEPEND_ON_STORAGE",
  "RUNTIME_MUST_NOT_DECLARE_DEPENDENCY_ON_AGENT",
  "RUNTIME_MUST_NOT_DECLARE_DEPENDENCY_ON_CLIENT",
  "RUNTIME_MUST_NOT_DECLARE_DEPENDENCY_ON_CODING_AGENT",
  "RUNTIME_MUST_NOT_DECLARE_DEPENDENCY_ON_DAEMON",
  "RUNTIME_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
  "RUNTIME_MUST_NOT_DEPEND_ON_AGENT",
  "RUNTIME_MUST_NOT_DEPEND_ON_CLIENT",
  "RUNTIME_MUST_NOT_DEPEND_ON_CODING_AGENT",
  "RUNTIME_MUST_NOT_DEPEND_ON_DAEMON",
  "RUNTIME_MUST_NOT_DEPEND_ON_STORAGE",
  "STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_CLI",
  "STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_CLIENT",
  "STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_DAEMON",
  "STORAGE_MUST_NOT_DECLARE_DEPENDENCY_ON_WEB",
  "STORAGE_MUST_NOT_DEPEND_ON_CLI",
  "STORAGE_MUST_NOT_DEPEND_ON_CLIENT",
  "STORAGE_MUST_NOT_DEPEND_ON_DAEMON",
  "STORAGE_MUST_NOT_DEPEND_ON_WEB",
  "WEB_MUST_NOT_DECLARE_DEPENDENCY_ON_AGENT",
  "WEB_MUST_NOT_DECLARE_DEPENDENCY_ON_CODING_AGENT",
  "WEB_MUST_NOT_DECLARE_DEPENDENCY_ON_RUNTIME",
  "WEB_MUST_NOT_DECLARE_DEPENDENCY_ON_STORAGE",
  "WEB_MUST_NOT_DEPEND_ON_AGENT",
  "WEB_MUST_NOT_DEPEND_ON_CODING_AGENT",
  "WEB_MUST_NOT_DEPEND_ON_RUNTIME",
  "WEB_MUST_NOT_DEPEND_ON_STORAGE",
]);

const PHASE_1A_FROZEN_RULE_ID_SET = new Set(PHASE_1A_FROZEN_RULE_IDS);

/**
 * Public boundary rule ids. These are evaluated by shape, not by package pair, so
 * they are not part of the frozen dependency rule list.
 */
export const PUBLIC_BOUNDARY_RULE_IDS = Object.freeze([
  "PACKAGE_MUST_NOT_BE_IMPORTED_THROUGH_SRC",
  "PACKAGE_MUST_NOT_IMPORT_ANOTHER_PROJECT_BY_RELATIVE_PATH",
  "PACKAGE_SUBPATH_MUST_BE_DECLARED_IN_EXPORTS",
]);

/**
 * Rule ids Phase 1B introduces that report pre-existing debt on the current
 * tree. They are admitted only through the audited expansion protocol.
 */
export function expansionRuleIds() {
  return RULE_IDS.filter((id) => !PHASE_1A_FROZEN_RULE_ID_SET.has(id));
}

/**
 * @typedef {{
 *   kind: "source-import",
 *   rule: string,
 *   edgeClass: string,
 *   sourcePackage: string,
 *   sourcePath: string,
 *   targetPackage: string,
 *   specifier: string,
 *   specifiers: { specifier: string, importKinds: string[] }[],
 * }} SourceBaselineEntry
 *
 * @typedef {{
 *   kind: "package-manifest",
 *   rule: string,
 *   edgeClass: string,
 *   sourcePackage: string,
 *   sourcePath: string,
 *   targetPackage: string,
 *   specifier: string,
 *   dependencyField: string,
 * }} ManifestBaselineEntry
 *
 * @typedef {{
 *   kind: "private-import",
 *   rule: string,
 *   edgeClass: string,
 *   sourcePackage: string,
 *   sourcePath: string,
 *   targetPackage: string,
 *   specifier: string,
 *   subpath: string,
 * }} PrivateImportBaselineEntry
 *
 * @typedef {{
 *   kind: "cross-workspace-relative-import",
 *   rule: string,
 *   edgeClass: string,
 *   sourcePackage: string,
 *   sourcePath: string,
 *   targetPackage: string,
 *   specifier: string,
 * }} RelativeImportBaselineEntry
 *
 * @typedef {SourceBaselineEntry | ManifestBaselineEntry | PrivateImportBaselineEntry | RelativeImportBaselineEntry} BaselineEntry
 */

/**
 * A baselined violation is identified by the dependency edge only, except for a
 * private import, whose identity is the exact specifier that bypasses the public
 * export surface.
 *
 * Line numbers, columns, occurrence counts, specifier order, and deep subpaths
 * are deliberately excluded so that ordinary editing, adding a second import, or
 * switching to a subpath never churns the frozen baseline.
 *
 * @param {BaselineEntry} entry
 * @returns {string}
 */
export function baselineKey(entry) {
  const specifierPart = entry.kind === "private-import" ? entry.specifier : "";
  return [
    entry.kind,
    entry.sourcePackage,
    entry.sourcePath,
    entry.targetPackage,
    entry.rule,
    entry.dependencyField ?? "",
    specifierPart,
  ].join("\u0000");
}

const BASELINE_ENTRY_COMPARATOR = (left, right) =>
  left.kind.localeCompare(right.kind) ||
  left.sourcePackage.localeCompare(right.sourcePackage) ||
  left.sourcePath.localeCompare(right.sourcePath) ||
  left.targetPackage.localeCompare(right.targetPackage) ||
  left.rule.localeCompare(right.rule) ||
  (left.dependencyField ?? "").localeCompare(right.dependencyField ?? "") ||
  (left.kind === "private-import" ? left.specifier : "").localeCompare(
    right.kind === "private-import" ? right.specifier : "",
  );

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
 * Project an evaluated violation onto its stable baseline entry form. Line and
 * column are dropped; only reviewed, stable data is retained.
 *
 * @param {LocatedViolation} violation
 * @returns {BaselineEntry}
 */
export function toBaselineEntry(violation) {
  switch (violation.kind) {
    case "private-import":
      return {
        kind: "private-import",
        rule: violation.rule,
        edgeClass: violation.edgeClass,
        sourcePackage: violation.sourcePackage,
        sourcePath: violation.sourcePath,
        targetPackage: violation.targetPackage,
        specifier: violation.specifier,
        subpath: violation.subpath,
      };
    case "cross-workspace-relative-import":
      return {
        kind: "cross-workspace-relative-import",
        rule: violation.rule,
        edgeClass: violation.edgeClass,
        sourcePackage: violation.sourcePackage,
        sourcePath: violation.sourcePath,
        targetPackage: violation.targetPackage,
        specifier: violation.specifier,
      };
    case "package-manifest":
      return {
        kind: "package-manifest",
        rule: violation.rule,
        edgeClass: violation.edgeClass,
        sourcePackage: violation.sourcePackage,
        sourcePath: violation.sourcePath,
        targetPackage: violation.targetPackage,
        specifier: violation.specifier,
        dependencyField: violation.dependencyField,
      };
    default:
      return {
        kind: "source-import",
        rule: violation.rule,
        edgeClass: violation.edgeClass,
        sourcePackage: violation.sourcePackage,
        sourcePath: violation.sourcePath,
        targetPackage: violation.targetPackage,
        specifier: violation.specifier,
        specifiers: violation.specifiers,
      };
  }
}

/**
 * @typedef {BaselineEntry & {
 *   line: number,
 *   column: number,
 *   detail: Record<string, unknown>,
 * }} LocatedViolation
 */

/**
 * Evaluate every scanned edge against the frozen Architecture V2 rule matrix and
 * the public boundary rules.
 *
 * @param {Awaited<ReturnType<typeof scanWorkspace>>} scan
 * @returns {{
 *   violations: LocatedViolation[],
 *   sourceEdges: number,
 *   manifestEdges: number,
 *   privateImports: number,
 *   crossWorkspaceRelativeImports: number,
 * }}
 */
export function evaluateScan(scan) {
  /** @type {LocatedViolation[]} */
  const violations = [];

  for (const edge of scan.sourceEdges) {
    const matched = findRule("source-import", edge.sourcePackage, edge.targetPackage);
    if (!matched) {
      continue;
    }
    violations.push({
      kind: "source-import",
      rule: matched.id,
      edgeClass: matched.kind,
      sourcePackage: edge.sourcePackage,
      sourcePath: edge.sourcePath,
      targetPackage: edge.targetPackage,
      specifier: edge.normalizedSpecifier,
      specifiers: edge.specifiers.map((record) => ({
        specifier: record.specifier,
        importKinds: record.importKinds,
      })),
      line: edge.line,
      column: edge.column,
      detail: {
        rawSpecifier: edge.specifier,
        occurrenceCount: edge.occurrenceCount,
        importKind: edge.importKinds[0],
        importKinds: edge.importKinds,
        edgeClass: matched.kind,
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
      rule: matched.id,
      edgeClass: matched.kind,
      sourcePackage: edge.sourcePackage,
      sourcePath: edge.sourcePath,
      targetPackage: edge.targetPackage,
      specifier: edge.normalizedSpecifier,
      dependencyField: edge.dependencyField,
      line: edge.line,
      column: edge.column,
      detail: {
        dependencyField: edge.dependencyField,
        edgeClass: matched.kind,
      },
    });
  }

  for (const violation of scan.privateImports) {
    violations.push({
      kind: "private-import",
      rule: violation.rule,
      edgeClass: "private-import",
      sourcePackage: violation.sourcePackage,
      sourcePath: violation.sourcePath,
      targetPackage: violation.targetPackage,
      specifier: violation.specifier,
      subpath: violation.subpath,
      line: violation.line,
      column: violation.column,
      detail: { reason: violation.reason, subpath: violation.subpath },
    });
  }

  for (const violation of scan.crossWorkspaceRelativeImports) {
    violations.push({
      kind: "cross-workspace-relative-import",
      rule: violation.rule,
      edgeClass: "cross-workspace-relative-import",
      sourcePackage: violation.sourcePackage,
      sourcePath: violation.sourcePath,
      targetPackage: violation.targetPackage,
      specifier: violation.specifier,
      line: violation.line,
      column: violation.column,
      detail: { resolvedProject: violation.resolvedProject },
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
    privateImports: scan.privateImports.length,
    crossWorkspaceRelativeImports: scan.crossWorkspaceRelativeImports.length,
  };
}

/**
 * Compare the evaluated violations against the checked-in baseline.
 *
 * @param {{ violations: LocatedViolation[] }} evaluated
 * @param {BaselineEntry[]} baselineEntries
 * @returns {{
 *   matched: LocatedViolation[],
 *   newViolations: LocatedViolation[],
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

  /** @type {LocatedViolation[]} */
  const matched = [];
  /** @type {LocatedViolation[]} */
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
 * @param {{ violations: LocatedViolation[] }} evaluated
 * @param {{ gitHead: string, generatedAt: string, generatedByRuleExpansion?: boolean }} context
 * @returns {object}
 */
export function buildBaselineDocument(evaluated, context) {
  const entries = sortBaselineEntries(evaluated.violations.map(toBaselineEntry));
  const byRule = countBy(entries, (entry) => entry.rule);
  const bySource = countBy(entries, (entry) => entry.sourcePackage);

  return {
    $schema: "./legacy-import-baseline.schema.md",
    schemaVersion: BASELINE_SCHEMA_VERSION,
    ruleSetVersion: RULE_SET_VERSION,
    baselineSourceCommit: context.gitHead,
    generatedByRuleExpansion: context.generatedByRuleExpansion === true,
    generator: BASELINE_GENERATOR,
    generatedAt: context.generatedAt,
    expansionHistory: [
      {
        fromRuleSetVersion: PHASE_1A_RULE_SET_VERSION,
        toRuleSetVersion: RULE_SET_VERSION,
        sourceCommit: PHASE_1A_FINAL_COMMIT,
      },
    ],
    matchingSemantics:
      "An entry matches when kind, sourcePackage, sourcePath, targetPackage, rule and dependencyField are identical. A private import additionally matches on its exact specifier. Lines, columns, occurrence counts and deep subpaths are excluded so ordinary edits do not churn this file.",
    normalization:
      "Specifiers are normalized to the owning package: @caelush/agent, @caelush/agent/context and @caelush/agent/tools/foo all normalize to @caelush/agent. A package subpath is reported separately when it is not declared in that package's exports map.",
    ratchet:
      "This file may only shrink. A violation that is not listed here fails the check as NEW_VIOLATION. A listed entry with no matching violation fails the check as STALE_BASELINE_ENTRY. It may only grow through the audited rule-set expansion protocol, which requires running on exactly the recorded baselineSourceCommit with every scanned path committed, so the admitted entries are provably that commit's own debt.",
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
 * `ruleSetVersion` is excluded because it is validated separately: a rule set
 * change needs its own actionable failure message, not a generic drift report.
 *
 * @param {object} document
 * @returns {string}
 */
export function canonicalizeBaselineDocument(document) {
  const entries = sortBaselineEntries(parseBaselineDocument(document));
  const metadata = Object.fromEntries(
    Object.entries(document)
      .filter(([key]) => key !== "entries" && key !== "ruleSetVersion")
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

const BASELINE_ENTRY_KINDS = new Set([
  "source-import",
  "package-manifest",
  "private-import",
  "cross-workspace-relative-import",
]);

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
    if (!BASELINE_ENTRY_KINDS.has(/** @type {string} */ (record.kind))) {
      throw new Error(`${label} entry ${index} has unknown kind "${String(record.kind)}"`);
    }
    if (typeof record.specifier !== "string" || record.specifier === "") {
      throw new Error(`${label} entry ${index} is missing string field "specifier"`);
    }
    if (record.kind === "package-manifest" && typeof record.dependencyField !== "string") {
      throw new Error(`${label} entry ${index} is a manifest entry without "dependencyField"`);
    }
    if (record.kind === "private-import" && typeof record.subpath !== "string") {
      throw new Error(`${label} entry ${index} is a private import without "subpath"`);
    }

    return /** @type {BaselineEntry} */ ({
      kind: record.kind,
      rule: record.rule,
      edgeClass: typeof record.edgeClass === "string" ? record.edgeClass : record.kind,
      sourcePackage: record.sourcePackage,
      sourcePath: record.sourcePath,
      targetPackage: record.targetPackage,
      specifier: record.specifier,
      ...(record.kind === "package-manifest"
        ? { dependencyField: /** @type {string} */ (record.dependencyField) }
        : {}),
      ...(record.kind === "private-import"
        ? { subpath: /** @type {string} */ (record.subpath) }
        : {}),
      ...(record.kind === "source-import" && Array.isArray(record.specifiers)
        ? {
            specifiers: /** @type {{ specifier: string, importKinds: string[] }[]} */ (
              record.specifiers
            ),
          }
        : {}),
    });
  });
}

/**
 * @param {LocatedViolation} entry
 * @param {Map<string, { line: number, column: number }>} locationIndex
 * @returns {string}
 */
export function formatViolation(entry, locationIndex) {
  const location = locationIndex.get(baselineKey(entry));
  const lines = [
    "Architecture V2 violation",
    "",
    "Class:",
    entry.edgeClass,
    "",
    "Source:",
    entry.sourcePath,
  ];

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
  if (entry.kind === "private-import") {
    lines.push("", "Subpath:", entry.subpath, "", "Reason:", String(entry.detail.reason ?? ""));
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
 * Read a git value, retrying a few times before giving up.
 *
 * The retry exists because git can fail transiently (contention, antivirus, a
 * loaded CI box). Returning the fallback on the first failure would be
 * dangerous: a fallback HEAD silently changes whether the expansion protocol
 * admits a write, so a flaky read could flip an audit decision. Retrying makes a
 * transient failure survivable and a persistent one explicit.
 *
 * @param {string} root
 * @param {string[]} args
 * @param {string} fallback
 * @param {{ attempts?: number }} [options]
 * @returns {Promise<{ value: string, failed: boolean }>}
 */
async function readGitValueDetailed(root, args, fallback, options = {}) {
  const attempts = options.attempts ?? 3;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
      const value = stdout.trim();
      return { value: value === "" ? fallback : value, failed: value === "" };
    } catch (error) {
      lastError = error;
    }
  }
  void lastError;
  return { value: fallback, failed: true };
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {string} fallback
 * @returns {Promise<string>}
 */
async function readGitValue(root, args, fallback) {
  return (await readGitValueDetailed(root, args, fallback)).value;
}

/**
 * Is every scanned path in the working tree identical to its committed state?
 *
 * The expansion protocol admits a violation only when the tree that produced it
 * is the tree of `baselineSourceCommit`. A dirty scanned path means the scanned
 * graph is not the committed graph, so the admission proof would be invalid.
 *
 * @param {string} root
 * @returns {Promise<{ clean: boolean, dirtyPaths: string[], readable: boolean }>}
 */
async function scannedPathsAreCommitted(root) {
  const { value, failed } = await readGitValueDetailed(
    root,
    ["status", "--porcelain", "--", "packages", "apps"],
    "",
  );
  if (failed && value === "") {
    // An empty status is a normal, clean result; a failed read is not. They are
    // distinguished explicitly so a git failure can never be mistaken for a
    // clean tree and silently authorize an expansion.
    const probe = await readGitValueDetailed(root, ["rev-parse", "--git-dir"], "");
    if (probe.failed) {
      return { clean: false, dirtyPaths: ["<git unavailable>"], readable: false };
    }
  }
  const dirtyPaths = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/^\S+\s+/u, ""));
  return { clean: dirtyPaths.length === 0, dirtyPaths, readable: true };
}

/**
 * Decide whether writing the evaluated violations would grow the checked-in
 * baseline, and why that growth is or is not admissible.
 *
 * A missing or unreadable baseline counts as growth, because writing one would
 * introduce entries that were not reviewed and committed.
 *
 * @param {string} baselinePath
 * @param {{ violations: LocatedViolation[] }} evaluated
 * @param {{ acceptRuleExpansion: boolean, baselineSourceCommit?: string, root: string }} options
 * @returns {Promise<{
 *   grows: boolean,
 *   admitted: boolean,
 *   refusal?: string,
 *   detail: string,
 *   additions: LocatedViolation[],
 *   newRuleViolations: LocatedViolation[],
 * }>}
 */
export async function auditBaselineGrowth(baselinePath, evaluated, options) {
  /** @type {BaselineEntry[]} */
  let existing = [];
  let baselineReadable = true;
  try {
    existing = parseBaselineDocument(
      JSON.parse(await readFile(baselinePath, "utf8")),
      path.basename(baselinePath),
    );
  } catch {
    baselineReadable = false;
  }

  const existingKeys = new Set(existing.map((entry) => baselineKey(entry)));
  const additions = evaluated.violations.filter(
    (violation) => !existingKeys.has(baselineKey(violation)),
  );

  const newRuleViolations = additions.filter(
    (violation) => !PHASE_1A_FROZEN_RULE_ID_SET.has(violation.rule),
  );

  const refuse = (refusal, detail) => ({
    grows: true,
    admitted: false,
    refusal,
    detail,
    additions,
    newRuleViolations,
  });

  if (additions.length === 0) {
    return {
      grows: false,
      admitted: true,
      detail: baselineReadable
        ? "no entry would be added; the write can only remove entries"
        : "no entry would be added",
      additions,
      newRuleViolations,
    };
  }

  if (!options.acceptRuleExpansion) {
    return refuse(
      "expansion-not-accepted",
      [
        `${additions.length} entr${additions.length === 1 ? "y" : "ies"} would be added`,
        "the shrink-only ratchet does not grow the baseline",
      ].join("\n"),
    );
  }

  if (options.baselineSourceCommit === undefined || options.baselineSourceCommit === "") {
    return refuse(
      "missing-baseline-source-commit",
      [
        "--accept-rule-expansion requires --baseline-source-commit <sha>",
        "the protocol admits only violations proven to exist at that commit",
      ].join("\n"),
    );
  }

  const { value: head, failed: headUnreadable } = await readGitValueDetailed(
    options.root,
    ["rev-parse", "HEAD"],
    UNKNOWN_HEAD,
  );
  if (headUnreadable) {
    return refuse(
      "git-provenance-unreadable",
      [
        "could not read HEAD from the scan root",
        "the expansion protocol cannot prove anything without a readable commit, so it fails closed",
      ].join("\n"),
    );
  }
  if (head !== options.baselineSourceCommit) {
    return refuse(
      "baseline-source-commit-mismatch",
      [
        `HEAD is ${head}`,
        `--baseline-source-commit is ${options.baselineSourceCommit}`,
        "check out the exact baseline source commit before expanding the baseline",
      ].join("\n"),
    );
  }

  const { clean, dirtyPaths, readable } = await scannedPathsAreCommitted(options.root);
  if (!readable) {
    return refuse(
      "git-status-unreadable",
      [
        "could not read the committed state of the scanned paths",
        "the expansion protocol cannot prove the tree is the committed tree, so it fails closed",
      ].join("\n"),
    );
  }
  if (!clean) {
    return refuse(
      "scanned-paths-not-committed",
      [
        "the scanned paths are not identical to their committed state:",
        ...dirtyPaths.slice(0, 20).map((dirtyPath) => `  ${dirtyPath}`),
        "a dirty tree cannot prove that a violation already existed at the baseline source commit",
      ].join("\n"),
    );
  }

  const historical = additions.length - newRuleViolations.length;
  const pinnedToPhase1a = options.baselineSourceCommit === PHASE_1A_FINAL_COMMIT;
  return {
    grows: true,
    admitted: true,
    detail: [
      `rule-set expansion admitted ${additions.length} pre-existing violation(s)`,
      `every scanned path is committed at ${options.baselineSourceCommit}`,
      pinnedToPhase1a
        ? "baseline source commit is the Phase 1A final commit"
        : `WARNING: baseline source commit is not the Phase 1A final commit ${PHASE_1A_FINAL_COMMIT}`,
      pinnedToPhase1a
        ? "the admitted set is therefore exactly the Phase 1A tree's own debt"
        : "the admitted set may include debt that landed after Phase 1A; a reviewer must confirm every added entry",
      `${historical} admitted by rules Phase 1A already enforced,`,
      `${newRuleViolations.length} admitted by rules Phase 1B newly enforces on the same tree`,
      `rule set version ${PHASE_1A_RULE_SET_VERSION} -> ${RULE_SET_VERSION} (${expansionRuleIds().length} new rule ids)`,
    ].join("\n"),
    additions,
    newRuleViolations,
  };
}

/**
 * Read the `generatedByRuleExpansion` flag from a checked-in baseline.
 *
 * The flag records that this baseline was produced by the audited rule-set
 * expansion. It must survive a later regeneration that only shrinks the file,
 * otherwise re-running the tool would silently erase the audit trail.
 *
 * @param {string} baselinePath
 * @returns {Promise<boolean>}
 */
async function readBaselineExpansionFlag(baselinePath) {
  try {
    const document = JSON.parse(await readFile(baselinePath, "utf8"));
    return document.generatedByRuleExpansion === true;
  } catch {
    return false;
  }
}

/**
 * Run the full boundary check.
 *
 * @param {{
 *   root?: string,
 *   baselinePath?: string,
 *   writeBaseline?: boolean,
 *   verifyBaseline?: boolean,
 *   acceptRuleExpansion?: boolean,
 *   markRuleExpansion?: boolean,
 *   baselineSourceCommit?: string,
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
  const acceptRuleExpansion = options.acceptRuleExpansion === true;
  const markRuleExpansion = options.markRuleExpansion === true;

  const scan = await scanWorkspace(root);
  const evaluated = evaluateScan(scan);

  const unknownRules = evaluated.violations
    .filter(
      (violation) =>
        !RULE_IDS.includes(violation.rule) && !PUBLIC_BOUNDARY_RULE_IDS.includes(violation.rule),
    )
    .map((violation) => violation.rule);
  if (unknownRules.length > 0) {
    throw new Error(`Evaluated violations reference unknown rules: ${unknownRules.join(", ")}`);
  }

  // When a write is pinned to a baseline source commit, that commit IS the
  // provenance of the admitted set. Reading git again would let the recorded
  // metadata disagree with the commit the expansion protocol actually proved
  // admission against.
  const provenance = await resolveProvenance(
    root,
    writeBaseline && options.baselineSourceCommit !== undefined
      ? { ...options, gitHead: options.baselineSourceCommit }
      : options,
  );
  const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "false";

  if (writeBaseline) {
    const audit = await auditBaselineGrowth(baselinePath, evaluated, {
      acceptRuleExpansion,
      baselineSourceCommit: options.baselineSourceCommit,
      root,
    });

    if (audit.grows && ci) {
      return {
        exitCode: 1,
        output: [
          "Architecture V2 baseline write refused",
          "",
          "Reason:",
          "ci-baseline-growth",
          "",
          "Detail:",
          "regenerating the baseline would add entries, and CI never grows the baseline",
          "",
          "Action:",
          "fix the new violation, or run the audited rule-set expansion locally and",
          "commit the reviewed baseline",
        ].join("\n"),
        summary: {
          refused: "ci-baseline-growth",
          written: false,
          violations: evaluated.violations.length,
        },
      };
    }

    if (audit.grows && !audit.admitted) {
      return {
        exitCode: 1,
        output: [
          "Architecture V2 baseline write refused",
          "",
          "Reason:",
          audit.refusal ?? "unknown",
          "",
          "Detail:",
          audit.detail,
          "",
          "Action:",
          "fix the new violation, or use the audited rule-set expansion protocol:",
          "  node scripts/architecture/check-boundaries.mjs --write-baseline \\",
          "    --accept-rule-expansion --baseline-source-commit <phase-1a-sha>",
          "  while HEAD is exactly that commit and the scanned paths are committed",
        ].join("\n"),
        summary: {
          refused: audit.refusal ?? "unknown",
          written: false,
          violations: evaluated.violations.length,
        },
      };
    }

    const document = buildBaselineDocument(evaluated, {
      ...provenance,
      // Sticky: an expansion is recorded once and survives later shrink-only
      // regenerations, so re-running the tool cannot erase the audit trail.
      // `--mark-rule-expansion` records the fact without adding entries, which
      // is how a baseline whose expansion flag was lost gets its audit trail
      // restored without inventing entries.
      generatedByRuleExpansion:
        markRuleExpansion ||
        (audit.grows && audit.admitted) ||
        (await readBaselineExpansionFlag(baselinePath)),
    });
    await writeFile(baselinePath, renderBaselineDocument(document), "utf8");
    return {
      exitCode: 0,
      output: [
        "Architecture V2 baseline written",
        "",
        "File:",
        path.relative(root, baselinePath).split(path.sep).join("/"),
        "",
        "Rule set version:",
        String(RULE_SET_VERSION),
        "",
        "Entries:",
        String(document.entryCount),
        "",
        "Audit:",
        audit.detail,
      ].join("\n"),
      summary: {
        written: true,
        entries: document.entryCount,
        violations: evaluated.violations.length,
        growthAudit: audit.detail,
      },
    };
  }

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

  const parsedDocument = JSON.parse(baselineRaw);
  const baselineEntries = parseBaselineDocument(parsedDocument, path.relative(root, baselinePath));

  const comparison = compareWithBaseline(evaluated, baselineEntries);
  const locationIndex = new Map(
    evaluated.violations.map((violation) => [
      baselineKey(violation),
      { line: violation.line, column: violation.column },
    ]),
  );

  /** @type {string[]} */
  const problems = [];

  if (comparison.newViolations.length > 0) {
    problems.push(
      ...comparison.newViolations.map((violation) => formatViolation(violation, locationIndex)),
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
  const baselineRuleSetVersion =
    typeof parsedDocument.ruleSetVersion === "number" ? parsedDocument.ruleSetVersion : undefined;

  if (baselineRuleSetVersion !== RULE_SET_VERSION) {
    return {
      exitCode: 1,
      output: [
        "Architecture V2 baseline rule set version mismatch",
        "",
        "Baseline rule set version:",
        String(baselineRuleSetVersion ?? "<absent>"),
        "",
        "Current rule set version:",
        String(RULE_SET_VERSION),
        "",
        "Action:",
        "this baseline was produced by a different rule set;",
        "regenerate it through the audited rule-set expansion protocol and commit the reviewed diff",
      ].join("\n"),
      summary: {
        baselineRuleSetVersion: baselineRuleSetVersion ?? null,
        ruleSetVersion: RULE_SET_VERSION,
        newViolations: comparison.newViolations.length,
        staleBaselineEntries: comparison.staleEntries.length,
      },
    };
  }

  if (verifyBaseline) {
    const currentDocument = buildBaselineDocument(evaluated, {
      gitHead:
        typeof parsedDocument.baselineSourceCommit === "string"
          ? parsedDocument.baselineSourceCommit
          : UNKNOWN_HEAD,
      generatedAt:
        typeof parsedDocument.generatedAt === "string"
          ? parsedDocument.generatedAt
          : UNKNOWN_HEAD_DATE,
      generatedByRuleExpansion: parsedDocument.generatedByRuleExpansion === true,
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
        "Whitespace, key order, entry order and ruleSetVersion are normalized before comparison; only entry content and the descriptive metadata count as drift.",
      ].join("\n");
    }
  }

  const summary = {
    projects: scan.projects.length,
    sourceFiles: scan.sourceFileCount,
    sourceImports: scan.sourceImportCount,
    sourceEdges: evaluated.sourceEdges,
    manifestEdges: evaluated.manifestEdges,
    privateImports: evaluated.privateImports,
    crossWorkspaceRelativeImports: evaluated.crossWorkspaceRelativeImports,
    unknownCaelushSpecifiers: scan.unknownCaelushSpecifiers,
    ruleSetVersion: RULE_SET_VERSION,
    ruleCount: DEPENDENCY_RULES.length,
    ruleCountsByKind: ruleCountsByKind(),
    baselineRuleSetVersion: baselineRuleSetVersion ?? null,
    baselineSourceCommit: parsedDocument.baselineSourceCommit ?? null,
    baselineEntries: baselineEntries.length,
    matchedLegacyViolations: comparison.matched.length,
    newViolations: comparison.newViolations.length,
    staleBaselineEntries: comparison.staleEntries.length,
    duplicateBaselineEntries: comparison.duplicateBaselineKeys.length,
    violationsByRule: countBy(evaluated.violations, (violation) => violation.rule),
    violationsByKind: countBy(evaluated.violations, (violation) => violation.edgeClass),
    violationsBySourcePackage: countBy(
      evaluated.violations,
      (violation) => violation.sourcePackage,
    ),
    violationsByTargetPackage: countBy(
      evaluated.violations,
      (violation) => violation.targetPackage,
    ),
    legacyViolationsByRule: countBy(comparison.matched, (violation) => violation.rule),
    legacyViolationsByKind: countBy(comparison.matched, (violation) => violation.edgeClass),
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
    `rule set version:          ${String(summary.ruleSetVersion)}`,
    `active rules:              ${String(summary.ruleCount)}`,
    `workspace projects:        ${String(summary.projects)}`,
    `scanned source files:      ${String(summary.sourceFiles)}`,
    `parsed module specifiers:  ${String(summary.sourceImports)}`,
    `workspace source edges:    ${String(summary.sourceEdges)}`,
    `workspace manifest edges:  ${String(summary.manifestEdges)}`,
    `private subpath imports:   ${String(summary.privateImports)}`,
    `cross-project rel. imports:${String(summary.crossWorkspaceRelativeImports)}`,
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
    acceptRuleExpansion: false,
    markRuleExpansion: false,
    baselineSourceCommit: /** @type {string | undefined} */ (undefined),
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
      case "--accept-rule-expansion":
        options.acceptRuleExpansion = true;
        break;
      case "--mark-rule-expansion":
        options.markRuleExpansion = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--baseline-source-commit": {
        const value = argv[index + 1];
        if (!value) throw new Error("--baseline-source-commit requires a sha argument");
        options.baselineSourceCommit = value;
        index += 1;
        break;
      }
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
                      deterministic baseline for the current checkout, or when it
                      was produced by a different rule set version.
  --write-baseline    Explicitly regenerate scripts/architecture/legacy-import-baseline.json.
                      Refused whenever the write would ADD entries, unless the
                      audited rule-set expansion protocol is satisfied:
                        --accept-rule-expansion
                        --baseline-source-commit <sha>
                      with HEAD exactly that commit and every scanned path
                      committed. Refused in CI regardless of flags.
  --accept-rule-expansion   Opt in to the one-time audited baseline expansion.
  --mark-rule-expansion     Record that this baseline came from the audited
                      expansion without adding entries. Used to restore an audit
                      trail whose flag was lost; it never admits a violation.
  --baseline-source-commit <sha>  The Phase 1A commit that proves every newly
                      baselined violation already existed. The scan must run on
                      exactly this commit with a clean scanned tree.
  --json              Print the machine-readable summary as JSON.
  --report <path>     Write the machine-readable summary to a file.
  --root <path>       Repository root. Defaults to the repository containing this script.
  --baseline <path>   Baseline file. Defaults to scripts/architecture/legacy-import-baseline.json.
  --help, -h          Print this message.

Exit codes:
  0  no NEW violation, no STALE baseline entry
  1  at least one NEW violation, at least one STALE baseline entry, a missing or
     invalid baseline, a rule set version mismatch, baseline drift under
     --verify-baseline, or a refused write
  2  unknown command-line argument

Rule set version: ${RULE_SET_VERSION}
Frozen Architecture V2 rule count: ${DEPENDENCY_RULES.length}
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
    acceptRuleExpansion: options.acceptRuleExpansion,
    markRuleExpansion: options.markRuleExpansion,
    baselineSourceCommit: options.baselineSourceCommit,
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
