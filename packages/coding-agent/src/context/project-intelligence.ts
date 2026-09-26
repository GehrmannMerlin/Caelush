import path from "node:path";

import type { WorkspaceRef } from "@caelush/protocol";
import type { Runtime, RuntimeWorkspaceScope } from "@caelush/runtime";

export type ProjectEcosystem = "NODE" | "PYTHON" | "RUST" | "GO" | "JAVA";
export type ProjectLanguageSignal = "TYPESCRIPT";
export type PackageManagerName = "pnpm" | "yarn" | "npm" | "bun" | "uv" | "poetry" | "UNKNOWN";

export interface CodingProjectDiagnostic {
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

export type ProjectRootReason =
  "VCS_MARKER" | "WORKSPACE_MARKER" | "PROJECT_MANIFEST" | "CWD_FALLBACK";

export interface ProjectRootDetectionResult {
  readonly projectRoot: string;
  readonly reason: ProjectRootReason;
  readonly marker?: string;
  readonly evidencePath?: string;
}

export type InstructionKind = "OVERRIDE" | "AGENTS" | "FALLBACK";

export interface ProjectInstruction {
  readonly path: string;
  readonly relativePath: string;
  readonly kind: InstructionKind;
  readonly depth: number;
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface ProjectInstructions {
  readonly entries: readonly ProjectInstruction[];
  readonly totalBytes: number;
  readonly maxBytes: number;
}

export interface CodingWorkspaceScope {
  readonly workspace: WorkspaceRef;
  readonly logicalRoot: string;
  readonly realRoot: string;
  readonly cwd: string;
  readonly realCwd: string;
}

export interface EnvironmentSnapshot {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly hostNodeVersion: string;
  readonly pathStyle: "POSIX" | "WINDOWS";
  readonly workspaceRoot: string;
  readonly projectRoot: string;
  readonly cwd: string;
}

export interface ProjectIntelligenceSnapshot {
  readonly workspace: CodingWorkspaceScope;
  readonly projectRoot: ProjectRootDetectionResult;
  readonly environment: EnvironmentSnapshot;
  readonly profile: ProjectProfile;
  readonly instructions: ProjectInstructions;
  readonly diagnostics: readonly CodingProjectDiagnostic[];
}

export interface ProjectInspectorInput {
  readonly workspace: WorkspaceRef;
  readonly cwd?: string;
}

export interface ProjectInspector {
  inspect(input: ProjectInspectorInput): Promise<ProjectIntelligenceSnapshot>;
}

export function createLocalProjectInspector(runtime: Runtime): ProjectInspector {
  return new RuntimeProjectInspector(runtime);
}

class RuntimeProjectInspector implements ProjectInspector {
  constructor(private readonly runtime: Runtime) {}

  async inspect(input: ProjectInspectorInput): Promise<ProjectIntelligenceSnapshot> {
    const scope = await this.runtime.openWorkspace(input.workspace);
    const workspace = await resolveWorkspaceScope(scope, input.cwd);
    const projectRoot = await detectProjectRoot(scope, workspace.realCwd, workspace.realRoot);
    const profileResult = await detectProfile(scope, projectRoot.projectRoot, workspace.realCwd);
    const instructions = await discoverInstructions(
      scope,
      projectRoot.projectRoot,
      workspace.realCwd,
    );
    return {
      workspace,
      projectRoot,
      environment: {
        platform: process.platform,
        arch: process.arch,
        hostNodeVersion: process.version,
        pathStyle: path.sep === "\\" ? "WINDOWS" : "POSIX",
        workspaceRoot: workspace.realRoot,
        projectRoot: projectRoot.projectRoot,
        cwd: workspace.realCwd,
      },
      profile: profileResult.profile,
      instructions,
      diagnostics: profileResult.diagnostics,
    };
  }
}

const knownManifests: readonly { readonly name: string; readonly ecosystem?: ProjectEcosystem }[] =
  [
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
const projectManifests = knownManifests.map((manifest) => manifest.name);

async function resolveWorkspaceScope(
  scope: RuntimeWorkspaceScope,
  configuredCwd: string | undefined,
): Promise<CodingWorkspaceScope> {
  const cwd =
    configuredCwd === undefined
      ? scope.logicalRoot
      : path.isAbsolute(configuredCwd)
        ? path.normalize(configuredCwd)
        : path.resolve(scope.logicalRoot, configuredCwd);
  if (!inside(scope.logicalRoot, cwd)) throw new Error(`cwd is outside workspace: ${cwd}`);
  const realCwd = path.normalize(await scope.filesystem.realpath(cwd));
  if (!inside(scope.realRoot, realCwd)) {
    throw new Error(`cwd resolves outside workspace: ${realCwd}`);
  }
  return {
    workspace: scope.workspace,
    logicalRoot: scope.logicalRoot,
    realRoot: scope.realRoot,
    cwd,
    realCwd,
  };
}

async function detectProjectRoot(
  scope: RuntimeWorkspaceScope,
  cwd: string,
  root: string,
): Promise<ProjectRootDetectionResult> {
  const directories = ancestors(cwd, root);
  for (const directory of directories) {
    const markerPath = path.join(directory, ".git");
    if (await exists(scope, markerPath)) {
      return {
        projectRoot: directory,
        reason: "VCS_MARKER",
        marker: ".git",
        evidencePath: markerPath,
      };
    }
  }
  for (const directory of directories) {
    for (const marker of monorepoMarkers) {
      const markerPath = path.join(directory, marker);
      if (await exists(scope, markerPath)) {
        return {
          projectRoot: directory,
          reason: "WORKSPACE_MARKER",
          marker,
          evidencePath: markerPath,
        };
      }
    }
  }
  for (const directory of directories) {
    const packagePath = path.join(directory, "package.json");
    if ((await exists(scope, packagePath)) && (await hasWorkspacesField(scope, packagePath))) {
      return {
        projectRoot: directory,
        reason: "WORKSPACE_MARKER",
        marker: "package.json#workspaces",
        evidencePath: packagePath,
      };
    }
  }
  for (const directory of directories) {
    for (const manifest of projectManifests) {
      const evidencePath = path.join(directory, manifest);
      if (await exists(scope, evidencePath)) {
        return {
          projectRoot: directory,
          reason: "PROJECT_MANIFEST",
          marker: manifest,
          evidencePath,
        };
      }
    }
  }
  return { projectRoot: cwd, reason: "CWD_FALLBACK" };
}

async function detectProfile(
  scope: RuntimeWorkspaceScope,
  projectRoot: string,
  cwd: string,
): Promise<{
  readonly profile: ProjectProfile;
  readonly diagnostics: readonly CodingProjectDiagnostic[];
}> {
  const diagnostics: CodingProjectDiagnostic[] = [];
  const directories = [...ancestors(cwd, projectRoot)].reverse();
  const manifestEvidence: ProjectManifestEvidence[] = [];
  const ecosystems = new Set<ProjectEcosystem>();
  const languageSignals: ProjectLanguageSignal[] = [];
  const packages: ProjectPackage[] = [];
  for (const directory of directories) {
    for (const manifest of knownManifests) {
      const targetPath = path.join(directory, manifest.name);
      if (!(await exists(scope, targetPath))) continue;
      const evidence = evidencePath(projectRoot, targetPath);
      manifestEvidence.push(
        manifest.ecosystem === undefined
          ? evidence
          : { ...evidence, ecosystem: manifest.ecosystem },
      );
      if (manifest.ecosystem !== undefined) ecosystems.add(manifest.ecosystem);
      if (manifest.name === "package.json") {
        const text = await readText(scope, targetPath, 1024 * 1024, diagnostics, "MANIFEST");
        if (text === null) continue;
        try {
          const projectPackage = parsePackage(JSON.parse(text), targetPath, projectRoot);
          if (projectPackage !== null) packages.push(projectPackage);
        } catch {
          diagnostics.push({
            code: "MALFORMED_MANIFEST",
            severity: "WARNING",
            message: "package.json is not valid JSON",
            path: targetPath,
          });
        }
      }
    }
    if (
      (await exists(scope, path.join(directory, "tsconfig.json"))) &&
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
  for (const marker of monorepoMarkers) {
    const markerPath = path.join(projectRoot, marker);
    if (await exists(scope, markerPath))
      monorepoEvidence.push(evidencePath(projectRoot, markerPath));
  }
  if (rootPackage?.workspaces !== undefined) {
    monorepoEvidence.push({
      ...evidencePath(projectRoot, rootPackage.path),
      type: "package.json#workspaces",
    });
  }
  const packageManager = await detectPackageManager(scope, rootPackage, projectRoot, diagnostics);
  const tooling = detectTooling(manifestEvidence);
  return {
    profile: {
      ecosystems: (["NODE", "PYTHON", "RUST", "GO", "JAVA"] as const).filter((entry) =>
        ecosystems.has(entry),
      ),
      languageSignals,
      manifestEvidence,
      packageManager,
      tooling,
      isMonorepo: monorepoEvidence.length > 0,
      monorepoEvidence,
      ...(rootPackage === undefined ? {} : { rootPackage }),
      ...(activePackage === undefined ? {} : { activePackage }),
    },
    diagnostics,
  };
}

async function detectPackageManager(
  scope: RuntimeWorkspaceScope,
  rootPackage: ProjectPackage | undefined,
  projectRoot: string,
  diagnostics: CodingProjectDiagnostic[],
): Promise<PackageManagerInfo> {
  if (rootPackage?.packageManager !== undefined) {
    const [name, versionHint] = rootPackage.packageManager.split("@", 2);
    const supported: readonly PackageManagerName[] = ["pnpm", "yarn", "npm", "bun", "uv", "poetry"];
    if (!supported.includes(name as PackageManagerName))
      return { name: "UNKNOWN", evidencePaths: [rootPackage.path] };
    return {
      name: name as PackageManagerName,
      ...(versionHint === undefined ? {} : { versionHint }),
      source: "PACKAGE_MANAGER_FIELD",
      evidencePaths: [rootPackage.path],
    };
  }
  const evidence = [] as Array<{ readonly manager: PackageManagerName; readonly path: string }>;
  for (const lockfile of lockfiles) {
    const targetPath = path.join(projectRoot, lockfile.name);
    if (await exists(scope, targetPath))
      evidence.push({ manager: lockfile.manager, path: targetPath });
  }
  const managers = [...new Set(evidence.map((entry) => entry.manager))];
  if (managers.length > 1) {
    diagnostics.push({
      code: "AMBIGUOUS_PACKAGE_MANAGER",
      severity: "WARNING",
      message: "multiple conflicting lockfiles were found",
      path: projectRoot,
    });
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

function detectTooling(
  manifestEvidence: readonly ProjectManifestEvidence[],
): readonly ProjectToolEvidence[] {
  const byManifest: Readonly<Record<string, ProjectToolEvidence["name"]>> = {
    "Cargo.toml": "cargo",
    "go.mod": "go",
    "pom.xml": "maven",
    "build.gradle": "gradle",
    "build.gradle.kts": "gradle",
  };
  return (["cargo", "go", "maven", "gradle"] as const)
    .map((name) => ({
      name,
      evidencePaths: manifestEvidence
        .filter((entry) => byManifest[entry.type] === name)
        .map((entry) => entry.path),
    }))
    .filter((entry) => entry.evidencePaths.length > 0);
}

async function discoverInstructions(
  scope: RuntimeWorkspaceScope,
  projectRoot: string,
  cwd: string,
): Promise<ProjectInstructions> {
  const maxBytes = 32 * 1024;
  const entries: ProjectInstruction[] = [];
  let remaining = maxBytes;
  for (const [depth, directory] of [...ancestors(cwd, projectRoot)].reverse().entries()) {
    if (remaining === 0) break;
    const selected = await selectInstruction(scope, directory);
    if (selected === null) continue;
    const targetPath = path.join(directory, selected.filename);
    const realPath = await scope.filesystem.realpath(targetPath);
    if (!inside(scope.realRoot, realPath))
      throw new Error(`instruction resolves outside workspace: ${targetPath}`);
    const file = await readRuntimeText(scope, targetPath, remaining);
    if (file.text.trim() === "") continue;
    entries.push({
      path: targetPath,
      relativePath: path.relative(projectRoot, targetPath),
      kind: selected.kind,
      depth,
      content: file.text,
      bytes: file.bytes,
      truncated: file.truncated,
    });
    remaining = Math.max(0, remaining - file.bytes);
    if (file.truncated || file.bytes === 0) break;
  }
  return { entries, totalBytes: maxBytes - remaining, maxBytes };
}

async function selectInstruction(
  scope: RuntimeWorkspaceScope,
  directory: string,
): Promise<{ readonly filename: string; readonly kind: InstructionKind } | null> {
  for (const candidate of [
    { filename: "AGENTS.override.md", kind: "OVERRIDE" as const },
    { filename: "AGENTS.md", kind: "AGENTS" as const },
    { filename: "CLAUDE.md", kind: "FALLBACK" as const },
  ]) {
    const metadata = await scope.filesystem.getMetadata(path.join(directory, candidate.filename));
    if (metadata === null) continue;
    if (metadata.kind === "DIRECTORY")
      throw new Error(`project instruction is not a file: ${candidate.filename}`);
    return candidate;
  }
  return null;
}

function ancestors(start: string, root: string): readonly string[] {
  const result: string[] = [];
  let cursor = path.normalize(start);
  const normalizedRoot = path.normalize(root);
  while (inside(normalizedRoot, cursor)) {
    result.push(cursor);
    if (cursor === normalizedRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return result;
}

async function hasWorkspacesField(
  scope: RuntimeWorkspaceScope,
  packagePath: string,
): Promise<boolean> {
  try {
    const text = await readRuntimeText(scope, packagePath, 1024 * 1024);
    const parsed: unknown = JSON.parse(text.text);
    return isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "workspaces");
  } catch {
    return false;
  }
}

async function exists(scope: RuntimeWorkspaceScope, targetPath: string): Promise<boolean> {
  return (await scope.filesystem.getMetadata(targetPath)) !== null;
}

async function readText(
  scope: RuntimeWorkspaceScope,
  targetPath: string,
  maxBytes: number,
  diagnostics: CodingProjectDiagnostic[],
  label: string,
): Promise<string | null> {
  try {
    const realPath = await scope.filesystem.realpath(targetPath);
    if (!inside(scope.realRoot, realPath)) {
      diagnostics.push({
        code: `${label}_OUTSIDE_WORKSPACE`,
        severity: "WARNING",
        message: `${label.toLowerCase()} resolves outside workspace`,
        path: targetPath,
      });
      return null;
    }
    return (await readRuntimeText(scope, targetPath, maxBytes)).text;
  } catch (error) {
    diagnostics.push({
      code: `${label}_READ_FAILURE`,
      severity: "WARNING",
      message: error instanceof Error ? error.message : `${label.toLowerCase()} could not be read`,
      path: targetPath,
    });
    return null;
  }
}

async function readRuntimeText(
  scope: RuntimeWorkspaceScope,
  targetPath: string,
  maxBytes: number,
): Promise<{ readonly text: string; readonly bytes: number; readonly truncated: boolean }> {
  const read = await scope.filesystem.readTextFile(targetPath, {
    offset: 0,
    limit: maxBytes,
    maxBytes,
  });
  return {
    text: read.lines.map((line) => line.replace(/^\d+: /, "")).join("\n"),
    bytes: read.bytesReturned,
    truncated: read.truncated,
  };
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
  const engines = isRecord(value.engines) ? stringValue(value.engines.node) : undefined;
  const name = stringValue(value.name);
  const packageManager = stringValue(value.packageManager);
  return {
    path: packagePath,
    relativePath: path.relative(projectRoot, packagePath),
    scripts,
    ...(name === undefined ? {} : { name }),
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(engines === undefined ? {} : { nodeVersionRange: engines }),
    ...(workspaces === undefined ? {} : { workspaces }),
  };
}

function evidencePath(projectRoot: string, targetPath: string): ProjectManifestEvidence {
  return {
    path: targetPath,
    relativePath: path.relative(projectRoot, targetPath),
    type: path.basename(targetPath),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(target));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
