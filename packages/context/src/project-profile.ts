import path from "node:path";
import type { ContextFileSystem } from "./filesystem.js";
import { ancestors } from "./project-root.js";
import type { WorkspaceScope } from "./workspace.js";
import { isWithinWorkspace } from "./workspace.js";

export type ProjectEcosystem = "NODE" | "PYTHON" | "RUST" | "GO" | "JAVA";
export type ProjectLanguageSignal = "TYPESCRIPT";
export type PackageManagerName = "pnpm" | "yarn" | "npm" | "bun" | "uv" | "poetry" | "UNKNOWN";

export interface ContextDiagnostic {
  readonly code: string;
  readonly severity: "WARNING" | "ERROR";
  readonly message: string;
  readonly path?: string;
}

export interface ProjectManifestEvidence {
  readonly path: string;
  readonly relativePath: string;
  readonly type: string;
  readonly ecosystem?: ProjectEcosystem;
}

export interface ProjectScript {
  readonly name: string;
  readonly command: string;
}

export interface ProjectPackage {
  readonly path: string;
  readonly relativePath: string;
  readonly name?: string;
  readonly packageManager?: string;
  readonly nodeVersionRange?: string;
  readonly scripts: readonly ProjectScript[];
  readonly workspaces?: boolean | readonly string[];
}

export interface PackageManagerInfo {
  readonly name: PackageManagerName;
  readonly versionHint?: string;
  readonly source?: "PACKAGE_MANAGER_FIELD" | "LOCKFILE" | "AMBIGUOUS";
  readonly evidencePaths: readonly string[];
}

export interface ProjectToolEvidence {
  readonly name: "cargo" | "go" | "maven" | "gradle";
  readonly evidencePaths: readonly string[];
}

export interface ProjectProfile {
  readonly ecosystems: readonly ProjectEcosystem[];
  readonly languageSignals: readonly ProjectLanguageSignal[];
  readonly manifestEvidence: readonly ProjectManifestEvidence[];
  readonly packageManager: PackageManagerInfo;
  readonly tooling: readonly ProjectToolEvidence[];
  readonly isMonorepo: boolean;
  readonly monorepoEvidence: readonly ProjectManifestEvidence[];
  readonly rootPackage?: ProjectPackage;
  readonly activePackage?: ProjectPackage;
}

interface KnownManifest {
  readonly name: string;
  readonly ecosystem?: ProjectEcosystem;
}

const knownManifests: readonly KnownManifest[] = [
  { name: "package.json", ecosystem: "NODE" },
  { name: "pyproject.toml", ecosystem: "PYTHON" },
  { name: "Cargo.toml", ecosystem: "RUST" },
  { name: "go.mod", ecosystem: "GO" },
  { name: "pom.xml", ecosystem: "JAVA" },
  { name: "build.gradle", ecosystem: "JAVA" },
  { name: "build.gradle.kts", ecosystem: "JAVA" },
];

const lockfiles = [
  { name: "pnpm-lock.yaml", manager: "pnpm" },
  { name: "yarn.lock", manager: "yarn" },
  { name: "package-lock.json", manager: "npm" },
  { name: "npm-shrinkwrap.json", manager: "npm" },
  { name: "bun.lock", manager: "bun" },
  { name: "bun.lockb", manager: "bun" },
  { name: "uv.lock", manager: "uv" },
  { name: "poetry.lock", manager: "poetry" },
] as const;

const monorepoMarkers = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "rush.json"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePackage(
  value: unknown,
  packagePath: string,
  projectRoot: string,
): ProjectPackage | null {
  if (!isRecord(value)) return null;
  const scripts = isRecord(value.scripts)
    ? Object.entries(value.scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, command]) => ({ name, command }))
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  const workspaces = Array.isArray(value.workspaces)
    ? value.workspaces.filter((entry): entry is string => typeof entry === "string")
    : typeof value.workspaces === "boolean"
      ? value.workspaces
      : undefined;
  const nodeVersionRange = isRecord(value.engines) ? stringValue(value.engines.node) : undefined;
  const name = stringValue(value.name);
  const packageManager = stringValue(value.packageManager);
  return {
    path: packagePath,
    relativePath: path.relative(projectRoot, packagePath),
    scripts,
    ...(name === undefined ? {} : { name }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(nodeVersionRange === undefined ? {} : { nodeVersionRange }),
    ...(workspaces === undefined ? {} : { workspaces }),
  };
}

function diagnostic(code: string, message: string, targetPath: string): ContextDiagnostic {
  return { code, severity: "WARNING", message, path: targetPath };
}

function parseManager(value: string): { name: PackageManagerName; versionHint?: string } {
  const [name, versionHint] = value.split("@", 2);
  const supported: readonly PackageManagerName[] = ["pnpm", "yarn", "npm", "bun", "uv", "poetry"];
  if (!supported.includes(name as PackageManagerName)) return { name: "UNKNOWN" };
  return versionHint === undefined
    ? { name: name as PackageManagerName }
    : { name: name as PackageManagerName, versionHint };
}

function evidencePath(projectRoot: string, targetPath: string): ProjectManifestEvidence {
  return {
    path: targetPath,
    relativePath: path.relative(projectRoot, targetPath),
    type: path.basename(targetPath),
  };
}

async function readManifest(
  filesystem: ContextFileSystem,
  scope: WorkspaceScope,
  targetPath: string,
  diagnostics: ContextDiagnostic[],
): Promise<string | null> {
  try {
    const realPath = await filesystem.realpath(targetPath);
    if (!isWithinWorkspace(scope.realRoot, realPath)) {
      diagnostics.push(
        diagnostic("MANIFEST_OUTSIDE_WORKSPACE", "manifest resolves outside workspace", targetPath),
      );
      return null;
    }
    return (await filesystem.readTextFile(targetPath, { maxBytes: 1024 * 1024 })).text;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "MANIFEST_READ_FAILURE",
        error instanceof Error ? error.message : "manifest could not be read",
        targetPath,
      ),
    );
    return null;
  }
}

async function exists(filesystem: ContextFileSystem, targetPath: string): Promise<boolean> {
  const metadata = await filesystem.getMetadata(targetPath);
  return metadata?.kind === "FILE" || metadata?.kind === "SYMLINK";
}

export class ProjectProfileDetector {
  constructor(private readonly filesystem: ContextFileSystem) {}

  async detect(
    scope: WorkspaceScope,
    projectRoot: string,
  ): Promise<{ profile: ProjectProfile; diagnostics: readonly ContextDiagnostic[] }> {
    const diagnostics: ContextDiagnostic[] = [];
    const directories = [...ancestors(scope.realCwd, projectRoot)].reverse();
    const manifestEvidence: ProjectManifestEvidence[] = [];
    const ecosystems = new Set<ProjectEcosystem>();
    const languageSignals: ProjectLanguageSignal[] = [];
    const packages: ProjectPackage[] = [];
    for (const directory of directories) {
      for (const manifest of knownManifests) {
        const targetPath = path.join(directory, manifest.name);
        if (!(await exists(this.filesystem, targetPath))) continue;
        const evidence = evidencePath(projectRoot, targetPath);
        const manifestEvidenceEntry =
          manifest.ecosystem === undefined
            ? evidence
            : { ...evidence, ecosystem: manifest.ecosystem };
        if (manifest.ecosystem !== undefined) ecosystems.add(manifest.ecosystem);
        manifestEvidence.push(manifestEvidenceEntry);
        if (manifest.name === "package.json") {
          const text = await readManifest(this.filesystem, scope, targetPath, diagnostics);
          if (text === null) continue;
          try {
            const parsed: unknown = JSON.parse(text);
            const projectPackage = parsePackage(parsed, targetPath, projectRoot);
            if (projectPackage !== null) packages.push(projectPackage);
          } catch {
            diagnostics.push(
              diagnostic("MALFORMED_MANIFEST", "package.json is not valid JSON", targetPath),
            );
          }
        }
      }
      const tsconfigPath = path.join(directory, "tsconfig.json");
      if (
        (await exists(this.filesystem, tsconfigPath)) &&
        !languageSignals.includes("TYPESCRIPT")
      ) {
        languageSignals.push("TYPESCRIPT");
      }
    }

    const rootPackage = packages.find(
      (entry) => entry.path === path.join(projectRoot, "package.json"),
    );
    const activePackage = packages.at(-1);
    const monorepoEvidence: ProjectManifestEvidence[] = [];
    for (const name of monorepoMarkers) {
      const targetPath = path.join(projectRoot, name);
      if (await exists(this.filesystem, targetPath))
        monorepoEvidence.push(evidencePath(projectRoot, targetPath));
    }
    if (rootPackage?.workspaces !== undefined) {
      monorepoEvidence.push({
        ...evidencePath(projectRoot, rootPackage.path),
        type: "package.json#workspaces",
      });
    }

    const manager = await this.detectPackageManager(rootPackage, projectRoot, diagnostics);
    const tooling = await this.detectTooling(manifestEvidence);
    const profile: ProjectProfile = {
      ecosystems: (["NODE", "PYTHON", "RUST", "GO", "JAVA"] as const).filter((entry) =>
        ecosystems.has(entry),
      ),
      languageSignals,
      manifestEvidence,
      packageManager: manager,
      tooling,
      isMonorepo: monorepoEvidence.length > 0,
      monorepoEvidence,
      ...(rootPackage === undefined ? {} : { rootPackage }),
      ...(activePackage === undefined ? {} : { activePackage }),
    };
    return {
      profile,
      diagnostics,
    };
  }

  private async detectPackageManager(
    rootPackage: ProjectPackage | undefined,
    projectRoot: string,
    diagnostics: ContextDiagnostic[],
  ): Promise<PackageManagerInfo> {
    if (rootPackage?.packageManager !== undefined) {
      const parsed = parseManager(rootPackage.packageManager);
      return {
        ...parsed,
        source: "PACKAGE_MANAGER_FIELD",
        evidencePaths: [rootPackage.path],
      };
    }
    const evidence = [] as Array<{ manager: PackageManagerName; path: string }>;
    for (const lockfile of lockfiles) {
      const targetPath = path.join(projectRoot, lockfile.name);
      if (await exists(this.filesystem, targetPath))
        evidence.push({ manager: lockfile.manager, path: targetPath });
    }
    const managers = [...new Set(evidence.map((entry) => entry.manager))];
    if (managers.length > 1) {
      diagnostics.push(
        diagnostic(
          "AMBIGUOUS_PACKAGE_MANAGER",
          "multiple conflicting lockfiles were found",
          projectRoot,
        ),
      );
      return {
        name: "UNKNOWN",
        source: "AMBIGUOUS",
        evidencePaths: evidence.map((entry) => entry.path),
      };
    }
    const manager = managers[0];
    return manager === undefined
      ? { name: "UNKNOWN", evidencePaths: [] }
      : { name: manager, source: "LOCKFILE", evidencePaths: evidence.map((entry) => entry.path) };
  }

  private async detectTooling(
    manifestEvidence: readonly ProjectManifestEvidence[],
  ): Promise<readonly ProjectToolEvidence[]> {
    const toolByManifest: Readonly<Record<string, ProjectToolEvidence["name"]>> = {
      "Cargo.toml": "cargo",
      "go.mod": "go",
      "pom.xml": "maven",
      "build.gradle": "gradle",
      "build.gradle.kts": "gradle",
    };
    const result: ProjectToolEvidence[] = [];
    for (const name of ["cargo", "go", "maven", "gradle"] as const) {
      const paths = manifestEvidence
        .filter((entry) => toolByManifest[entry.type] === name)
        .map((entry) => entry.path);
      if (paths.length > 0) result.push({ name, evidencePaths: paths });
    }
    return result;
  }
}
