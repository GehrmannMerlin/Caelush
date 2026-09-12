/**
 * Caelush Architecture V2 workspace scanner.
 *
 * Responsibilities:
 *   1. Discover workspace projects under `packages/*` and `apps/*`.
 *   2. Extract every workspace dependency edge from each `package.json`
 *      (`dependencies`, `devDependencies`, `peerDependencies`,
 *      `optionalDependencies`).
 *   3. Extract every workspace dependency edge from source files using the
 *      TypeScript Compiler API (never a regular expression), covering static
 *      imports, `export ... from`, dynamic `import()`, and CommonJS `require()`.
 *   4. Normalize deep specifiers such as `@caelush/agent/tools/foo` to the
 *      owning package `@caelush/agent`.
 *
 * The scanner reports raw edges. It never decides whether an edge is legal;
 * rule evaluation lives in `v2-rules.mjs` and `check-boundaries.mjs`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { CAELUSH_SCOPE, MANIFEST_DEPENDENCY_FIELDS } from "./v2-rules.mjs";

/** Source extensions the checker parses. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Directory names that are generated output and never scanned. */
export const EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "dist-test",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vite",
  ".worktrees",
  "release-artifacts",
  "test-results",
  ".vitest",
  "__snapshots__",
]);

/** Path segments relative to a project root that mark generated output. */
const GENERATED_PATH_SEGMENTS = ["dist", "build", "coverage", "generated", ".cache"];

/**
 * @typedef {"static-import" | "export-from" | "dynamic-import" | "require-call"} SourceImportKind
 *
 * @typedef {{
 *   kind: SourceImportKind,
 *   specifier: string,
 *   line: number,
 *   column: number,
 * }} SourceImport
 *
 * @typedef {{
 *   identity: string,
 *   name: string,
 *   directory: string,
 *   relativeDirectory: string,
 *   workspaceKind: "package" | "app",
 *   manifestPath: string,
 *   manifestRelativePath: string,
 *   manifestDependencies: { field: string, name: string, version: unknown }[],
 * }} WorkspaceProject
 *
 * @typedef {{
 *   ruleKind: "source-import",
 *   sourcePackage: string,
 *   targetPackage: string,
 *   specifier: string,
 *   normalizedSpecifier: string,
 *   sourcePath: string,
 *   occurrenceCount: number,
 *   importKinds: SourceImportKind[],
 *   line: number,
 *   column: number,
 * }} EdgeViolation
 *
 * @typedef {{
 *   ruleKind: "package-manifest",
 *   sourcePackage: string,
 *   targetPackage: string,
 *   specifier: string,
 *   normalizedSpecifier: string,
 *   sourcePath: string,
 *   dependencyField: string,
 *   line: number,
 *   column: number,
 * }} ManifestViolation
 */

const IMPORT_KIND_ORDER = /** @type {SourceImportKind[]} */ ([
  "static-import",
  "export-from",
  "dynamic-import",
  "require-call",
]);

/**
 * @param {string} filePath
 * @returns {ts.ScriptKind}
 */
function scriptKindFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

/**
 * Extract every module specifier from one source file.
 *
 * @param {string} filePath absolute path, used only for script kind selection
 * @param {string} contents
 * @returns {SourceImport[]}
 */
export function extractSourceImports(filePath, contents) {
  const sourceFile = ts.createSourceFile(
    filePath,
    contents,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(filePath),
  );

  /** @type {SourceImport[]} */
  const imports = [];

  /**
   * @param {ts.Node} node
   * @param {SourceImportKind} kind
   */
  const record = (node, kind) => {
    if (!ts.isStringLiteralLike(node)) {
      return;
    }
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    imports.push({
      kind,
      specifier: node.text,
      line: position.line + 1,
      column: position.character + 1,
    });
  };

  /**
   * @param {ts.Node} node
   */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      record(node.moduleSpecifier, "static-import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record(node.moduleSpecifier, "export-from");
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && reference.expression) {
        record(reference.expression, "require-call");
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      record(node.arguments[0], "dynamic-import");
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length >= 1
    ) {
      record(node.arguments[0], "require-call");
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return imports;
}

/**
 * Normalize a module specifier into a Caelush workspace package name.
 * `@caelush/agent`, `@caelush/agent/context`, and `@caelush/agent/tools/foo`
 * all normalize to `@caelush/agent`. Non-Caelush specifiers return `undefined`.
 *
 * @param {string} specifier
 * @returns {string | undefined}
 */
export function normalizeCaelushSpecifier(specifier) {
  if (!specifier.startsWith(CAELUSH_SCOPE)) {
    return undefined;
  }

  const remainder = specifier.slice(CAELUSH_SCOPE.length);
  const [packageName] = remainder.split("/");
  if (!packageName) {
    return undefined;
  }

  return `${CAELUSH_SCOPE}${packageName}`;
}

/**
 * Normalize a Caelush workspace package name into its package identity.
 * `@caelush/coding-agent` becomes `coding-agent`.
 *
 * @param {string} specifier
 * @returns {string | undefined}
 */
export function packageIdentityFromSpecifier(specifier) {
  const normalized = normalizeCaelushSpecifier(specifier);
  return normalized?.slice(CAELUSH_SCOPE.length);
}

/**
 * A scannable source path lives at `<container>/<project>/<scopeRoot>/**` and is
 * neither generated output nor a VCS/install directory.
 *
 * @param {string} relativeFilePath repository-relative path using `/` separators
 * @param {string} [scopeRoot] `src` (authoritative) or `test` (diagnostic)
 * @returns {boolean}
 */
export function isScannableSourcePath(relativeFilePath, scopeRoot = "src") {
  const segments = relativeFilePath.split("/");
  if (segments.length < 4) {
    return false;
  }
  const [container, projectName, scopeDirectory, ...rest] = segments;
  if (container !== "packages" && container !== "apps") {
    return false;
  }
  if (!projectName || scopeDirectory !== scopeRoot || rest.length === 0) {
    return false;
  }
  const trailingSegments = rest.slice(0, -1);
  if (trailingSegments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) {
    return false;
  }
  if (trailingSegments.some((segment) => GENERATED_PATH_SEGMENTS.includes(segment))) {
    return false;
  }
  return SOURCE_EXTENSIONS.includes(path.extname(relativeFilePath).toLowerCase());
}

/**
 * @param {string} directory
 * @param {string[]} accumulator
 * @returns {Promise<string[]>}
 */
async function collectFilesRecursively(directory, accumulator = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      await collectFilesRecursively(entryPath, accumulator);
    } else if (entry.isFile()) {
      accumulator.push(entryPath);
    }
  }
  return accumulator;
}

/**
 * @param {string} directory
 * @returns {Promise<boolean>}
 */
async function directoryExists(directory) {
  try {
    const info = await stat(directory);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} root
 * @param {string} relativeDirectory
 * @returns {Promise<WorkspaceProject[]>}
 */
async function discoverProjects(root, relativeDirectory) {
  const container = path.join(root, relativeDirectory);
  if (!(await directoryExists(container))) {
    return [];
  }

  const entries = await readdir(container, { withFileTypes: true });
  /** @type {WorkspaceProject[]} */
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(container, entry.name, "package.json");
    if (!(await directoryExists(path.dirname(manifestPath)))) {
      continue;
    }
    let raw;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      continue;
    }
    const manifest = JSON.parse(raw);
    const name = typeof manifest.name === "string" ? manifest.name : undefined;
    if (name === undefined) {
      throw new Error(`Workspace project ${relativeDirectory}/${entry.name} has no package name`);
    }

    /** @type {{ field: string, name: string, version: unknown }[]} */
    const manifestDependencies = [];
    for (const field of MANIFEST_DEPENDENCY_FIELDS) {
      const section = manifest[field];
      if (!section || typeof section !== "object") {
        continue;
      }
      for (const dependencyName of Object.keys(section)) {
        manifestDependencies.push({
          field,
          name: dependencyName,
          version: section[dependencyName],
        });
      }
    }

    projects.push({
      identity: name.startsWith(CAELUSH_SCOPE) ? name.slice(CAELUSH_SCOPE.length) : name,
      name,
      directory: path.join(container, entry.name),
      relativeDirectory: `${relativeDirectory}/${entry.name}`,
      workspaceKind: relativeDirectory === "packages" ? "package" : "app",
      manifestPath,
      manifestRelativePath: `${relativeDirectory}/${entry.name}/package.json`,
      manifestDependencies,
    });
  }

  return projects.sort((left, right) =>
    left.relativeDirectory.localeCompare(right.relativeDirectory),
  );
}

/**
 * Discover every workspace project declared by the pnpm workspace globs
 * `packages/*` and `apps/*`.
 *
 * @param {string} root absolute repository root
 * @returns {Promise<WorkspaceProject[]>}
 */
export async function discoverWorkspaceProjects(root) {
  const [packages, apps] = await Promise.all([
    discoverProjects(root, "packages"),
    discoverProjects(root, "apps"),
  ]);
  return [...packages, ...apps];
}

/**
 * @param {string} root
 * @param {WorkspaceProject} project
 * @param {string} scopeRoot
 * @returns {Promise<{ path: string, contents: string }[]>}
 */
async function readProjectSources(root, project, scopeRoot) {
  const sourceRoot = path.join(project.directory, scopeRoot);
  if (!(await directoryExists(sourceRoot))) {
    return [];
  }

  const files = await collectFilesRecursively(sourceRoot);
  const scannable = files
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((relativeFilePath) => isScannableSourcePath(relativeFilePath, scopeRoot))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    scannable.map(async (relativeFilePath) => {
      const absolutePath = path.join(root, relativeFilePath);
      return { path: absolutePath, contents: await readFile(absolutePath, "utf8") };
    }),
  );
}

/**
 * Produce a stable dependency key for source edges within one source file.
 *
 * @param {string} sourcePath
 * @param {string} targetPackage
 */
function sourceEdgeKey(sourcePath, targetPackage) {
  return `${sourcePath}\u0000source-import\u0000${targetPackage}`;
}

/**
 * @typedef {{
 *   sourceEdges: EdgeViolation[],
 *   sourceFileCount: number,
 *   sourceImportCount: number,
 *   unknownCaelushSpecifiers: { sourcePath: string, specifier: string, line: number, column: number }[],
 * }} SourceScopeScan
 */

/**
 * Scan one scope root (`src` or `test`) across every workspace project.
 *
 * @param {string} root
 * @param {WorkspaceProject[]} projects
 * @param {Map<string, WorkspaceProject>} projectByIdentity
 * @param {string} scopeRoot
 * @returns {Promise<SourceScopeScan>}
 */
async function scanSourceScope(root, projects, projectByIdentity, scopeRoot) {
  /** @type {Map<string, EdgeViolation & { importKindSet: Set<SourceImportKind> }>} */
  const sourceEdges = new Map();
  /** @type {{ sourcePath: string, specifier: string, line: number, column: number }[]} */
  const unknownCaelushSpecifiers = [];

  let sourceFileCount = 0;
  let sourceImportCount = 0;

  for (const project of projects) {
    const sources = await readProjectSources(root, project, scopeRoot);
    sourceFileCount += sources.length;

    for (const source of sources) {
      const relativeSourcePath = path.relative(root, source.path).split(path.sep).join("/");
      const imports = extractSourceImports(source.path, source.contents);
      sourceImportCount += imports.length;

      for (const entry of imports) {
        const normalized = normalizeCaelushSpecifier(entry.specifier);
        if (normalized === undefined) {
          continue;
        }
        const targetPackage = normalized.slice(CAELUSH_SCOPE.length);
        if (!projectByIdentity.has(targetPackage)) {
          unknownCaelushSpecifiers.push({
            sourcePath: relativeSourcePath,
            specifier: entry.specifier,
            line: entry.line,
            column: entry.column,
          });
          continue;
        }
        if (targetPackage === project.identity) {
          continue;
        }

        const key = sourceEdgeKey(relativeSourcePath, targetPackage);
        const existing = sourceEdges.get(key);
        if (existing) {
          existing.occurrenceCount += 1;
          existing.importKindSet.add(entry.kind);
          continue;
        }

        sourceEdges.set(key, {
          ruleKind: "source-import",
          sourcePackage: project.identity,
          targetPackage,
          specifier: entry.specifier,
          normalizedSpecifier: normalized,
          sourcePath: relativeSourcePath,
          occurrenceCount: 1,
          importKinds: [],
          importKindSet: new Set([entry.kind]),
          line: entry.line,
          column: entry.column,
        });
      }
    }
  }

  const orderedSourceEdges = [...sourceEdges.values()]
    .map((edge) => {
      const { importKindSet, ...rest } = edge;
      return {
        ...rest,
        importKinds: IMPORT_KIND_ORDER.filter((kind) => importKindSet.has(kind)),
      };
    })
    .sort(compareSourceEdges);

  return {
    sourceEdges: orderedSourceEdges,
    sourceFileCount,
    sourceImportCount,
    unknownCaelushSpecifiers: unknownCaelushSpecifiers.sort(
      (left, right) =>
        left.sourcePath.localeCompare(right.sourcePath) ||
        left.line - right.line ||
        left.column - right.column,
    ),
  };
}

/**
 * Scan the repository and return the complete raw dependency graph.
 *
 * `src` is the authoritative architecture surface and always drives the
 * baseline ratchet. Project `test` directories are a diagnostic-only surface:
 * they are scanned when `includeTests` is set and returned separately so they
 * can never enter the frozen baseline.
 *
 * @param {string} root absolute repository root
 * @param {{ includeTests?: boolean }} [options]
 * @returns {Promise<{
 *   projects: WorkspaceProject[],
 *   projectByIdentity: Map<string, WorkspaceProject>,
 *   sourceEdges: EdgeViolation[],
 *   manifestEdges: ManifestViolation[],
 *   sourceFileCount: number,
 *   sourceImportCount: number,
 *   unknownCaelushSpecifiers: { sourcePath: string, specifier: string, line: number, column: number }[],
 *   testSourceEdges: EdgeViolation[],
 *   testSourceFileCount: number,
 *   testSourceImportCount: number,
 * }>}
 */
export async function scanWorkspace(root, options = {}) {
  const projects = await discoverWorkspaceProjects(root);
  const projectByIdentity = new Map(projects.map((project) => [project.identity, project]));

  /** @type {ManifestViolation[]} */
  const manifestEdges = [];

  for (const project of projects) {
    const manifestContents = await readFile(project.manifestPath, "utf8");
    for (const { field, name } of project.manifestDependencies) {
      if (!name.startsWith(CAELUSH_SCOPE)) {
        continue;
      }
      const targetPackage = packageIdentityFromSpecifier(name);
      if (targetPackage === undefined || targetPackage === project.identity) {
        continue;
      }
      const located = locateInManifest(manifestContents, field, name);
      manifestEdges.push({
        ruleKind: "package-manifest",
        sourcePackage: project.identity,
        targetPackage,
        specifier: name,
        normalizedSpecifier: name,
        sourcePath: project.manifestRelativePath,
        dependencyField: field,
        line: located.line,
        column: located.column,
      });
    }
  }

  const sourceScope = await scanSourceScope(root, projects, projectByIdentity, "src");
  const testScope =
    options.includeTests === true
      ? await scanSourceScope(root, projects, projectByIdentity, "test")
      : { sourceEdges: [], sourceFileCount: 0, sourceImportCount: 0, unknownCaelushSpecifiers: [] };

  return {
    projects,
    projectByIdentity,
    sourceEdges: sourceScope.sourceEdges,
    manifestEdges: manifestEdges.sort(compareManifestViolations),
    sourceFileCount: sourceScope.sourceFileCount,
    sourceImportCount: sourceScope.sourceImportCount,
    unknownCaelushSpecifiers: sourceScope.unknownCaelushSpecifiers,
    testSourceEdges: testScope.sourceEdges,
    testSourceFileCount: testScope.sourceFileCount,
    testSourceImportCount: testScope.sourceImportCount,
  };
}

/**
 * @param {string} manifestContents
 * @param {string} field
 * @param {string} dependencyName
 * @returns {{ line: number, column: number }}
 */
function locateInManifest(manifestContents, field, dependencyName) {
  const lines = manifestContents.split(/\r?\n/);
  const fieldIndex = lines.findIndex((line) => line.includes(`"${field}"`));
  const quoted = `"${dependencyName}"`;
  const searchFrom = fieldIndex === -1 ? 0 : fieldIndex;
  for (let index = searchFrom; index < lines.length; index += 1) {
    const columnIndex = lines[index].indexOf(quoted);
    if (columnIndex !== -1) {
      return { line: index + 1, column: columnIndex + 1 };
    }
  }
  return { line: 1, column: 1 };
}

/**
 * @param {EdgeViolation} left
 * @param {EdgeViolation} right
 */
function compareSourceEdges(left, right) {
  return (
    left.sourcePath.localeCompare(right.sourcePath) ||
    left.targetPackage.localeCompare(right.targetPackage) ||
    left.line - right.line
  );
}

/**
 * @param {ManifestViolation} left
 * @param {ManifestViolation} right
 */
function compareManifestViolations(left, right) {
  return (
    left.sourcePath.localeCompare(right.sourcePath) ||
    left.targetPackage.localeCompare(right.targetPackage) ||
    left.dependencyField.localeCompare(right.dependencyField)
  );
}
