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
 * the declared interface below; `no-explicit-any` is disabled for those three
 * lines only, and nowhere else in the test suite.
 */
const CHECKER_MODULE = "../../../scripts/architecture/check-boundaries.mjs";
const SCANNER_MODULE = "../../../scripts/architecture/scan-workspace.mjs";
const RULES_MODULE = "../../../scripts/architecture/v2-rules.mjs";

export type SourceImportKind = "static-import" | "export-from" | "dynamic-import" | "require-call";

export type SourceImport = {
  kind: SourceImportKind;
  specifier: string;
  line: number;
  column: number;
};

export type BaselineEntryKind = "source-import" | "package-manifest";

export type BaselineEntry = {
  kind: BaselineEntryKind;
  sourcePackage: string;
  sourcePath: string;
  targetPackage: string;
  rule: string;
  specifier: string;
  dependencyField?: string;
};

export type LocatedViolation = BaselineEntry & {
  line: number;
  column: number;
  detail: Record<string, unknown>;
};

export type ScanResult = {
  projects: { identity: string; relativeDirectory: string }[];
  sourceEdges: unknown[];
  manifestEdges: unknown[];
  sourceFileCount: number;
  sourceImportCount: number;
  unknownCaelushSpecifiers: { sourcePath: string; specifier: string }[];
  testSourceEdges: { sourcePath: string }[];
  testSourceFileCount: number;
  testSourceImportCount: number;
};

export type EvaluatedScan = {
  violations: LocatedViolation[];
  sourceEdges: number;
  manifestEdges: number;
};

export type BaselineDocument = {
  schemaVersion: number;
  entryCount: number;
  entries: BaselineEntry[];
  [key: string]: unknown;
};

export type ViolationMessageFormat = {
  output: string;
  exitCode: number;
  summary: Record<string, number | string | boolean | unknown[]>;
};

export type BoundaryCheckOptions = {
  root?: string;
  baselinePath?: string;
  writeBaseline?: boolean;
  verifyBaseline?: boolean;
  gitHead?: string;
  gitHeadDate?: string;
  env?: Record<string, string | undefined>;
};

type ScannerImplementation = {
  normalizeCaelushSpecifier(specifier: string): string | undefined;
  packageIdentityFromSpecifier(specifier: string): string | undefined;
  extractSourceImports(filePath: string, contents: string): SourceImport[];
  isScannableSourcePath(relativeFilePath: string, scopeRoot?: string): boolean;
  scanWorkspace(root: string, options?: { includeTests?: boolean }): Promise<ScanResult>;
};

type RulesImplementation = {
  RULE_IDS: string[];
  DEPENDENCY_RULES: { id: string; kind: BaselineEntryKind; from: string; to: string }[];
  findRule(
    kind: BaselineEntryKind,
    fromPackage: string,
    toPackage: string,
  ): { id: string } | undefined;
};

type CheckerImplementation = {
  DEFAULT_BASELINE_PATH: string;
  evaluateScan(scan: ScanResult): EvaluatedScan;
  baselineKey(entry: BaselineEntry): string;
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
    context: { gitHead: string; generatedAt: string },
  ): BaselineDocument;
  renderBaselineDocument(document: BaselineDocument): string;
  parseBaselineDocument(value: unknown, label?: string): BaselineEntry[];
  runBoundaryCheck(options?: BoundaryCheckOptions): Promise<ViolationMessageFormat>;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- one cast per checker module, isolated to this facade */
const checkerImplementation: any = await import(CHECKER_MODULE);
const scannerImplementation: any = await import(SCANNER_MODULE);
const rulesImplementation: any = await import(RULES_MODULE);
/* eslint-enable @typescript-eslint/no-explicit-any */

export const scanner = scannerImplementation as ScannerImplementation;

export const rules = rulesImplementation as RulesImplementation;

export const boundaries = checkerImplementation as CheckerImplementation;
