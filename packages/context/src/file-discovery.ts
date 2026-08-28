import path from "node:path";
import { ContextBoundaryError, ContextDiscoveryError } from "./errors.js";
import type { ContextDiagnostic } from "./project-profile.js";
import type { ProjectIntelligenceSnapshot } from "./snapshot.js";
import type { ContextFileKind, ContextFileSystem } from "./filesystem.js";
import { isWithinWorkspace } from "./workspace.js";
import { IgnorePolicy, type IgnoreDecision } from "./ignore-policy.js";

export interface CandidateDiscoveryOptions {
  readonly maxVisitedEntries?: number;
  readonly maxCandidateFiles?: number;
  readonly maxDepth?: number;
}

export interface CandidateFile {
  readonly path: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly extension?: string;
  readonly depth: number;
}

export interface RelevantFileDiscoveryStats {
  readonly visitedEntries: number;
  readonly candidateFiles: number;
  readonly ignoredEntries: number;
  readonly hardExcludedEntries: number;
  readonly sensitiveSkipped: number;
  readonly binarySkipped: number;
  readonly symlinkSkipped: number;
  readonly nonTextSkipped: number;
  readonly readFailures: number;
  readonly truncatedByLimit: boolean;
}

export interface CandidateFileDiscoveryResult {
  readonly candidates: readonly CandidateFile[];
  readonly stats: RelevantFileDiscoveryStats;
  readonly diagnostics: readonly ContextDiagnostic[];
}

export interface CandidateFileDiscoveryDependencies {
  readonly filesystem: ContextFileSystem;
  readonly ignorePolicy?: IgnorePolicy;
}

interface MutableStats {
  visitedEntries: number;
  candidateFiles: number;
  ignoredEntries: number;
  hardExcludedEntries: number;
  sensitiveSkipped: number;
  binarySkipped: number;
  symlinkSkipped: number;
  nonTextSkipped: number;
  readFailures: number;
  truncatedByLimit: boolean;
}

interface PendingDirectory {
  readonly path: string;
  readonly depth: number;
}

const defaultOptions = {
  maxVisitedEntries: 20000,
  maxCandidateFiles: 5000,
  maxDepth: 32,
} as const;

function normalizePath(targetPath: string): string {
  return targetPath.replaceAll("\\", "/");
}

function diagnostic(code: string, message: string, targetPath?: string): ContextDiagnostic {
  return {
    code,
    severity: "WARNING",
    message,
    ...(targetPath === undefined ? {} : { path: targetPath }),
  };
}

function validateOption(name: string, value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ContextDiscoveryError(`${name} must be a positive safe integer`);
  }
  return result;
}

function compareEntries(
  left: { name: string; kind: ContextFileKind },
  right: { name: string; kind: ContextFileKind },
  priority: (name: string, kind: ContextFileKind) => number,
): number {
  return (
    priority(left.name, left.kind) - priority(right.name, right.kind) ||
    left.name.localeCompare(right.name)
  );
}

function directoryPriority(directory: string, snapshot: ProjectIntelligenceSnapshot): number {
  const cwd = snapshot.workspace.realCwd;
  const activePackagePath = snapshot.profile.activePackage?.path;
  const activePackageDirectory =
    activePackagePath === undefined ? undefined : path.dirname(activePackagePath);
  const inCwdRegion = isWithinWorkspace(directory, cwd) || isWithinWorkspace(cwd, directory);
  if (inCwdRegion) return 0;
  if (
    activePackageDirectory !== undefined &&
    (isWithinWorkspace(directory, activePackageDirectory) ||
      isWithinWorkspace(activePackageDirectory, directory))
  ) {
    return 1;
  }
  return 2;
}

function isInsideProject(projectRoot: string, targetPath: string): boolean {
  return isWithinWorkspace(projectRoot, targetPath);
}

function emptyStats(): MutableStats {
  return {
    visitedEntries: 0,
    candidateFiles: 0,
    ignoredEntries: 0,
    hardExcludedEntries: 0,
    sensitiveSkipped: 0,
    binarySkipped: 0,
    symlinkSkipped: 0,
    nonTextSkipped: 0,
    readFailures: 0,
    truncatedByLimit: false,
  };
}

function addDecisionStats(stats: MutableStats, decision: IgnoreDecision): void {
  if (decision.hardExcluded) stats.hardExcludedEntries += 1;
  if (decision.sensitive) stats.sensitiveSkipped += 1;
  if (decision.binary) stats.binarySkipped += 1;
  if (decision.ignored && !decision.hardExcluded && !decision.sensitive && !decision.binary) {
    stats.ignoredEntries += 1;
  }
}

export class CandidateFileDiscovery {
  constructor(private readonly dependencies: CandidateFileDiscoveryDependencies) {}

  async discover(
    snapshot: ProjectIntelligenceSnapshot,
    options: CandidateDiscoveryOptions = {},
  ): Promise<CandidateFileDiscoveryResult> {
    const maxVisitedEntries = validateOption(
      "maxVisitedEntries",
      options.maxVisitedEntries,
      defaultOptions.maxVisitedEntries,
    );
    const maxCandidateFiles = validateOption(
      "maxCandidateFiles",
      options.maxCandidateFiles,
      defaultOptions.maxCandidateFiles,
    );
    const maxDepth = validateOption("maxDepth", options.maxDepth, defaultOptions.maxDepth);
    const projectRoot = path.normalize(snapshot.projectRoot.projectRoot);
    const workspaceRoot = path.normalize(snapshot.workspace.realRoot);
    if (!isInsideProject(workspaceRoot, projectRoot)) {
      throw new ContextBoundaryError("project root is outside the workspace boundary");
    }
    const rootRealpath = await this.safeRealpath(projectRoot);
    if (
      rootRealpath === null ||
      !isInsideProject(workspaceRoot, rootRealpath) ||
      !isInsideProject(projectRoot, rootRealpath)
    ) {
      throw new ContextBoundaryError("project root resolves outside the workspace boundary");
    }
    const policy =
      this.dependencies.ignorePolicy ??
      new IgnorePolicy({
        filesystem: this.dependencies.filesystem,
        projectRoot,
        workspaceRoot,
      });
    const stats = emptyStats();
    const diagnostics: ContextDiagnostic[] = [];
    const candidates: CandidateFile[] = [];
    const instructionPaths = new Set(
      snapshot.instructions.entries.map((entry) => normalizePath(path.normalize(entry.path))),
    );
    const pending: PendingDirectory[] = [{ path: projectRoot, depth: 0 }];
    let limitDiagnosticAdded = false;

    const markLimit = (): void => {
      stats.truncatedByLimit = true;
      if (!limitDiagnosticAdded) {
        diagnostics.push(
          diagnostic("DISCOVERY_LIMIT_REACHED", "candidate discovery reached a configured limit"),
        );
        limitDiagnosticAdded = true;
      }
    };

    while (pending.length > 0 && !stats.truncatedByLimit) {
      const current = pending.shift();
      if (current === undefined) break;
      let entries;
      try {
        entries = await this.dependencies.filesystem.readDirectory(current.path);
      } catch (error) {
        stats.readFailures += 1;
        diagnostics.push(
          diagnostic(
            "DIRECTORY_READ_FAILURE",
            error instanceof Error ? error.message : "directory could not be read",
            current.path,
          ),
        );
        continue;
      }
      const sortedEntries = [...entries].sort((left, right) =>
        compareEntries(left, right, (name, kind) =>
          kind === "DIRECTORY"
            ? directoryPriority(path.join(current.path, name), snapshot)
            : directoryPriority(current.path, snapshot),
        ),
      );
      for (const entry of sortedEntries) {
        if (stats.visitedEntries >= maxVisitedEntries) {
          markLimit();
          break;
        }
        stats.visitedEntries += 1;
        const entryPath = path.join(current.path, entry.name);
        if (entry.kind === "SYMLINK") {
          stats.symlinkSkipped += 1;
          continue;
        }
        const decision = await policy.decide(entryPath, entry.kind);
        addDecisionStats(stats, decision);
        if (decision.ignored) continue;
        if (entry.kind === "DIRECTORY") {
          if (current.depth >= maxDepth) {
            markLimit();
            break;
          }
          const realEntryPath = await this.safeRealpath(entryPath, diagnostics, stats);
          if (realEntryPath === null) continue;
          if (
            !isInsideProject(workspaceRoot, realEntryPath) ||
            !isInsideProject(projectRoot, realEntryPath)
          ) {
            diagnostics.push(
              diagnostic(
                "DISCOVERY_OUTSIDE_BOUNDARY",
                "directory resolves outside discovery root",
                entryPath,
              ),
            );
            continue;
          }
          pending.push({ path: entryPath, depth: current.depth + 1 });
          pending.sort(
            (left, right) =>
              directoryPriority(left.path, snapshot) - directoryPriority(right.path, snapshot) ||
              left.path.localeCompare(right.path),
          );
          continue;
        }
        const realEntryPath = await this.safeRealpath(entryPath, diagnostics, stats);
        if (realEntryPath === null) continue;
        if (
          !isInsideProject(workspaceRoot, realEntryPath) ||
          !isInsideProject(projectRoot, realEntryPath)
        ) {
          diagnostics.push(
            diagnostic(
              "DISCOVERY_OUTSIDE_BOUNDARY",
              "file resolves outside discovery root",
              entryPath,
            ),
          );
          continue;
        }
        if (instructionPaths.has(normalizePath(path.normalize(entryPath)))) continue;
        if (candidates.length >= maxCandidateFiles) {
          markLimit();
          break;
        }
        const relativePath = normalizePath(path.relative(projectRoot, entryPath));
        const extension = path.extname(entry.name).toLowerCase();
        candidates.push({
          path: entryPath,
          relativePath,
          fileName: entry.name,
          ...(extension === "" ? {} : { extension }),
          depth: current.depth,
        });
        stats.candidateFiles += 1;
      }
    }

    return { candidates, stats, diagnostics };
  }

  private async safeRealpath(
    targetPath: string,
    diagnostics?: ContextDiagnostic[],
    stats?: MutableStats,
  ): Promise<string | null> {
    try {
      return await this.dependencies.filesystem.realpath(targetPath);
    } catch (error) {
      if (diagnostics === undefined || stats === undefined) {
        throw new ContextDiscoveryError(`could not resolve discovery root: ${targetPath}`, {
          cause: error,
        });
      }
      stats.readFailures += 1;
      diagnostics.push(
        diagnostic(
          "PATH_RESOLUTION_FAILURE",
          error instanceof Error ? error.message : "path could not be resolved",
          targetPath,
        ),
      );
      return null;
    }
  }
}
