/**
 * Typed facade over the plain-JavaScript Architecture V2 checker modules.
 *
 * The checker is `.mjs` so it can run from a bare `node` command without a build
 * step, and the repository root `tsconfig.json` deliberately covers only the
 * `tests` tree and the per-package test directories. A TypeScript test therefore
 * cannot resolve the `.mjs` specifier without `allowJs`, and `tsc --noEmit`
 * would reject the import outright.
 *
 * This module declares the slice of the checker surface the test suite uses and
 * binds it to the real implementation through a single, explicit cast. The cast
 * is intentional and narrow: it is the one place where a JavaScript module
 * becomes a typed dependency of a TypeScript test.
 */

/**
 * The specifiers are held in variables on purpose. A literal `.mjs` specifier
 * would be a hard TypeScript resolve error (`TS7016`) under a `tsconfig` that
 * does not enable `allowJs`, whereas a non-literal specifier resolves to an
 * untyped module. Exactly one cast per module turns that untyped binding into
 * the declared interface below; `no-explicit-any` is disabled for those four
 * lines only, and nowhere else in the test suite.
 */
const CHECKER_MODULE = "../../../scripts/architecture/check-boundaries.mjs";
const SCANNER_MODULE = "../../../scripts/architecture/scan-workspace.mjs";
const RULES_MODULE = "../../../scripts/architecture/v2-rules.mjs";
const MIGRATION_MAP_MODULE = "../../../scripts/architecture/v2-migration-map.mjs";
const READINESS_MODULE = "../../../scripts/architecture/check-migration-readiness.mjs";

export type SourceImportKind = "static-import" | "export-from" | "dynamic-import" | "require-call";

export type SourceImport = {
  kind: SourceImportKind;
  specifier: string;
  line: number;
  column: number;
};

export type BaselineEntryKind =
  "source-import" | "package-manifest" | "private-import" | "cross-workspace-relative-import";

export type BaselineEntry = {
  kind: BaselineEntryKind;
  rule: string;
  edgeClass: string;
  sourcePackage: string;
  sourcePath: string;
  targetPackage: string;
  specifier: string;
  dependencyField?: string;
  subpath?: string;
  specifiers?: { specifier: string; importKinds: string[] }[];
};

export type LocatedViolation = BaselineEntry & {
  line: number;
  column: number;
  detail: Record<string, unknown>;
};

export type ExportDeclaration = { subpath: string; target: unknown };

export type ScanProject = {
  identity: string;
  relativeDirectory: string;
  exportDeclarations: ExportDeclaration[];
};

export type ScanResult = {
  projects: ScanProject[];
  sourceEdges: {
    sourcePackage: string;
    targetPackage: string;
    sourcePath: string;
    specifier: string;
    normalizedSpecifier: string;
    occurrenceCount: number;
    importKinds: SourceImportKind[];
    specifiers: { specifier: string; importKinds: SourceImportKind[] }[];
  }[];
  manifestEdges: unknown[];
  sourceFileCount: number;
  sourceImportCount: number;
  unknownCaelushSpecifiers: { sourcePath: string; specifier: string }[];
  privateImports: {
    rule: string;
    sourcePackage: string;
    sourcePath: string;
    specifier: string;
    targetPackage: string;
    subpath: string;
    reason: string;
  }[];
  crossWorkspaceRelativeImports: {
    rule: string;
    sourcePackage: string;
    sourcePath: string;
    specifier: string;
    targetPackage: string;
    resolvedProject: string;
  }[];
  testSourceEdges: { sourcePath: string }[];
  testSourceFileCount: number;
  testSourceImportCount: number;
  testPrivateImports: unknown[];
  testCrossWorkspaceRelativeImports: unknown[];
};

export type EvaluatedScan = {
  violations: LocatedViolation[];
  sourceEdges: number;
  manifestEdges: number;
  privateImports: number;
  crossWorkspaceRelativeImports: number;
};

export type BaselineDocument = {
  schemaVersion: number;
  ruleSetVersion: number;
  baselineSourceCommit: string;
  generatedByRuleExpansion: boolean;
  entryCount: number;
  entries: BaselineEntry[];
  [key: string]: unknown;
};

export type BoundaryCheckResult = {
  output: string;
  exitCode: number;
  summary: Record<string, number | string | boolean | null | unknown[]>;
};

export type BoundaryCheckOptions = {
  root?: string;
  baselinePath?: string;
  writeBaseline?: boolean;
  verifyBaseline?: boolean;
  acceptRuleExpansion?: boolean;
  markRuleExpansion?: boolean;
  // exactOptionalPropertyTypes is on, so an explicitly passed undefined differs from
  // an absent property. Tests build this object from optional options, so the
  // undefined form must be permitted.
  baselineSourceCommit?: string | undefined;
  gitHead?: string;
  gitHeadDate?: string;
  env?: Record<string, string | undefined>;
};

export type GrowthAudit = {
  grows: boolean;
  admitted: boolean;
  refusal?: string;
  detail: string;
  additions: LocatedViolation[];
  newRuleViolations: LocatedViolation[];
};

export type DependencyRule = {
  id: string;
  layer: "source-import" | "package-manifest";
  kind: string;
  from: string;
  to: string;
  description: string;
};

export type MigrationOperation =
  "MOVE" | "SPLIT" | "RENAME" | "EXTRACT" | "ADAPT" | "PORT" | "FACADE" | "DELETE";

export type LegacyMigrationEntry = {
  legacyPackage: string;
  destinations: string[];
  primaryOperation: MigrationOperation;
  operations: MigrationOperation[];
  rationale: string;
  splitGuide?: { concern: string; destination: string }[];
};

type ScannerImplementation = {
  normalizeCaelushSpecifier(specifier: string): string | undefined;
  packageIdentityFromSpecifier(specifier: string): string | undefined;
  splitCaelushSpecifier(specifier: string): { packageName: string; subpath: string } | undefined;
  exportsDeclareSubpath(exportDeclarations: ExportDeclaration[], subpath: string): boolean;
  isScannableSourcePath(relativeFilePath: string, scopeRoot?: string): boolean;
  extractSourceImports(filePath: string, contents: string): SourceImport[];
  scanWorkspace(root: string, options?: { includeTests?: boolean }): Promise<ScanResult>;
};

type RulesImplementation = {
  RULE_IDS: string[];
  RULE_SET_VERSION: number;
  PHASE_1A_RULE_SET_VERSION: number;
  PHASE_1A_FINAL_COMMIT: string;
  DEPENDENCY_RULES: DependencyRule[];
  V2_ALLOWED_DEPENDENCIES: Record<string, readonly string[]>;
  V2_TARGET_PACKAGES: string[];
  V2_HOST_APPS: string[];
  V2_LEGACY_PACKAGES: string[];
  V2_FORBIDDEN_HOST_TO_TARGET: Record<string, readonly string[]>;
  V2_FORBIDDEN_TARGET_TO_HOST: string[];
  PUBLIC_BOUNDARY_RULES: Record<string, { id: string; kind: string; description: string }>;
  findRule(
    layer: "source-import" | "package-manifest",
    fromPackage: string,
    toPackage: string,
  ): DependencyRule | undefined;
  isAllowedTargetEdge(from: string, to: string): boolean;
  packageRole(identity: string): "target" | "host" | "legacy" | "unknown";
  deriveForbiddenTargetEdges(): { from: string; to: string }[];
  deriveForbiddenTargetToLegacyEdges(): { from: string; to: string }[];
  deriveForbiddenTargetToHostEdges(): { from: string; to: string }[];
  deriveForbiddenHostEdges(): { from: string; to: string }[];
  ruleCountsByKind(): Record<string, number>;
};

type CheckerImplementation = {
  DEFAULT_BASELINE_PATH: string;
  PHASE_1A_FROZEN_RULE_IDS: string[];
  PUBLIC_BOUNDARY_RULE_IDS: string[];
  expansionRuleIds(): string[];
  evaluateScan(scan: ScanResult): EvaluatedScan;
  baselineKey(entry: BaselineEntry): string;
  toBaselineEntry(violation: LocatedViolation): BaselineEntry;
  sortBaselineEntries(entries: BaselineEntry[]): BaselineEntry[];
  compareWithBaseline(
    evaluated: EvaluatedScan,
    baselineEntries: BaselineEntry[],
  ): {
    matched: LocatedViolation[];
    newViolations: LocatedViolation[];
    staleEntries: BaselineEntry[];
    duplicateBaselineKeys: string[];
  };
  buildBaselineDocument(
    evaluated: EvaluatedScan,
    context: { gitHead: string; generatedAt: string; generatedByRuleExpansion?: boolean },
  ): BaselineDocument;
  renderBaselineDocument(document: BaselineDocument): string;
  canonicalizeBaselineDocument(document: unknown): string;
  parseBaselineDocument(value: unknown, label?: string): BaselineEntry[];
  auditBaselineGrowth(
    baselinePath: string,
    evaluated: EvaluatedScan,
    options: {
      acceptRuleExpansion: boolean;
      baselineSourceCommit?: string | undefined;
      root: string;
    },
  ): Promise<GrowthAudit>;
  runBoundaryCheck(options?: BoundaryCheckOptions): Promise<BoundaryCheckResult>;
};

type MigrationMapImplementation = {
  MIGRATION_DELETE: string;
  MIGRATION_OPERATIONS: MigrationOperation[];
  LEGACY_MIGRATION_MAP: LegacyMigrationEntry[];
  MIGRATION_MAP_INDEX: Map<string, LegacyMigrationEntry>;
  migrationEntryFor(legacyPackage: string): LegacyMigrationEntry | undefined;
  allMigrationDestinations(): string[];
  deletedLegacyPackages(): string[];
};

export type ReadinessCondition = {
  id: string;
  title: string;
  ok: boolean;
  detail: string;
  findings: string[];
};

export type ReadinessResult = {
  ready: boolean;
  exitCode: number;
  output: string;
  conditions: ReadinessCondition[];
  summary: Record<string, unknown> & {
    targetPackages: number;
    targetPackagesPresent: number;
    legacyPackages: number;
    legacyPackagesMapped: number;
    baselineEntries: number;
    baselineClasses: Record<string, number>;
    baselineSourcePackages: Record<string, number>;
    baselineDestinations: Record<string, number>;
    privateImports: number;
    crossWorkspaceRelativeImports: number;
    testScopeCrossWorkspaceRelativeImports: number;
    testScopePrivateImports: number;
    failedConditions: string[];
    ready: boolean;
    newViolations?: number;
  };
};

type ReadinessImplementation = {
  MIGRATION_DEBT_CLASSES: string[];
  NON_MIGRATION_DEBT_CLASSES: string[];
  MIGRATION_DEBT_ENTRY_KINDS: string[];
  V2_SKELETON_PACKAGES: string[];
  REQUIRED_ROOT_SCRIPTS: string[];
  ARCHITECTURE_ENTRY_POINTS: string[];
  checkStaticContract(): string[];
  runMigrationReadinessCheck(options?: {
    root?: string;
    baselinePath?: string;
    head?: string;
    runCommandChecks?: boolean;
  }): Promise<ReadinessResult>;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- one cast per checker module, isolated to this facade */
const checkerImplementation: any = await import(CHECKER_MODULE);
const scannerImplementation: any = await import(SCANNER_MODULE);
const rulesImplementation: any = await import(RULES_MODULE);
const migrationMapImplementation: any = await import(MIGRATION_MAP_MODULE);
const readinessImplementation: any = await import(READINESS_MODULE);
/* eslint-enable @typescript-eslint/no-explicit-any */

export const scanner = scannerImplementation as ScannerImplementation;

export const rules = rulesImplementation as RulesImplementation;

export const boundaries = checkerImplementation as CheckerImplementation;

export const migrationMap = migrationMapImplementation as MigrationMapImplementation;

export const readiness = readinessImplementation as ReadinessImplementation;
