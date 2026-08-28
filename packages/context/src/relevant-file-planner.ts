import path from "node:path";
import {
  CandidateFileDiscovery,
  type CandidateDiscoveryOptions,
  type CandidateFileDiscoveryResult,
} from "./file-discovery.js";
import { IgnorePolicy } from "./ignore-policy.js";
import { FileBudgetSelector, type FileBudgetSelectionResult } from "./file-budget.js";
import { LocalContextFileSystem, type ContextFileSystem } from "./filesystem.js";
import { RelevantPathRanker, type RelevantFileQuery } from "./relevance.js";
import type { ProjectIntelligenceSnapshot } from "./snapshot.js";
import { type RelevantFileBudget, type RelevantFileContextPlan } from "./relevant-file-plan.js";
import { Utf8HeuristicTokenEstimator, type TokenEstimator } from "./token-estimator.js";
import type { ContextDiagnostic } from "./project-profile.js";

export interface RelevantFilePlannerInput {
  readonly snapshot: ProjectIntelligenceSnapshot;
  readonly query: RelevantFileQuery;
  readonly budget?: RelevantFileBudget;
  readonly discovery?: CandidateDiscoveryOptions;
}

export interface RelevantFilePlannerDependencies {
  readonly filesystem: ContextFileSystem;
  readonly estimator?: TokenEstimator;
  readonly ignorePolicy?: IgnorePolicy;
  readonly discovery?: CandidateFileDiscovery;
  readonly ranker?: RelevantPathRanker;
  readonly selector?: FileBudgetSelector;
}

function normalizePath(targetPath: string): string {
  return path.normalize(targetPath);
}

function diagnostic(code: string, message: string, targetPath?: string): ContextDiagnostic {
  return {
    code,
    severity: "WARNING",
    message,
    ...(targetPath === undefined ? {} : { path: targetPath }),
  };
}

function mergeStats(discovery: CandidateFileDiscoveryResult, selection: FileBudgetSelectionResult) {
  return {
    ...discovery.stats,
    nonTextSkipped: discovery.stats.nonTextSkipped + selection.nonTextSkipped,
    readFailures: discovery.stats.readFailures + selection.readFailures,
  };
}

export class RelevantFilePlanner {
  private readonly estimator: TokenEstimator;
  private readonly discovery: CandidateFileDiscovery;
  private readonly ranker: RelevantPathRanker;
  private readonly selector: FileBudgetSelector;

  constructor(private readonly dependencies: RelevantFilePlannerDependencies) {
    this.estimator = dependencies.estimator ?? new Utf8HeuristicTokenEstimator();
    this.discovery =
      dependencies.discovery ??
      new CandidateFileDiscovery(
        dependencies.ignorePolicy === undefined
          ? { filesystem: dependencies.filesystem }
          : { filesystem: dependencies.filesystem, ignorePolicy: dependencies.ignorePolicy },
      );
    this.ranker = dependencies.ranker ?? new RelevantPathRanker();
    this.selector =
      dependencies.selector ??
      new FileBudgetSelector({ filesystem: dependencies.filesystem, estimator: this.estimator });
  }

  async plan(input: RelevantFilePlannerInput): Promise<RelevantFileContextPlan> {
    const discovery = await this.discovery.discover(input.snapshot, input.discovery);
    const rankedCandidates = this.ranker.rank(discovery.candidates, input.query, input.snapshot);
    const selection = await this.selector.select(rankedCandidates, input.budget);
    const explicitDiagnostics = await this.inspectExplicitPaths(input.snapshot, input.query);
    return {
      query: input.query,
      rankedCandidates,
      sections: selection.sections,
      budget: selection.budget,
      discovery: mergeStats(discovery, selection),
      diagnostics: [
        ...input.snapshot.diagnostics,
        ...discovery.diagnostics,
        ...explicitDiagnostics,
        ...selection.diagnostics,
      ],
    };
  }

  private async inspectExplicitPaths(
    snapshot: ProjectIntelligenceSnapshot,
    query: RelevantFileQuery,
  ): Promise<readonly ContextDiagnostic[]> {
    const projectRoot = normalizePath(snapshot.projectRoot.projectRoot);
    const workspaceRoot = normalizePath(snapshot.workspace.realRoot);
    const policy =
      this.dependencies.ignorePolicy ??
      new IgnorePolicy({
        filesystem: this.dependencies.filesystem,
        projectRoot,
        workspaceRoot,
      });
    const diagnostics: ContextDiagnostic[] = [];
    for (const explicitPath of query.explicitPaths ?? []) {
      const targetPath = normalizePath(
        path.isAbsolute(explicitPath) ? explicitPath : path.resolve(projectRoot, explicitPath),
      );
      if (!isInside(projectRoot, targetPath) || !isInside(workspaceRoot, targetPath)) {
        diagnostics.push(
          diagnostic(
            "EXPLICIT_PATH_OUTSIDE_PROJECT",
            "explicit path is outside the project and workspace boundary",
            explicitPath,
          ),
        );
        continue;
      }
      let metadata;
      try {
        metadata = await this.dependencies.filesystem.getMetadata(targetPath);
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "EXPLICIT_PATH_READ_FAILURE",
            error instanceof Error ? error.message : "explicit path could not be inspected",
            explicitPath,
          ),
        );
        continue;
      }
      if (metadata === null) {
        diagnostics.push(
          diagnostic("EXPLICIT_PATH_NOT_FOUND", "explicit path was not found", explicitPath),
        );
        continue;
      }
      const decision = await policy.decide(targetPath, metadata.kind);
      if (decision.sensitive) {
        diagnostics.push(
          diagnostic(
            "SENSITIVE_AUTO_CONTEXT_BLOCKED",
            "sensitive files are not eligible for automatic context",
            explicitPath,
          ),
        );
      } else if (decision.ignored) {
        diagnostics.push(
          diagnostic(
            "EXPLICIT_PATH_BLOCKED",
            "explicit path is excluded from automatic context",
            explicitPath,
          ),
        );
      }
    }
    return diagnostics;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function createLocalRelevantFilePlanner(): RelevantFilePlanner {
  return new RelevantFilePlanner({ filesystem: new LocalContextFileSystem() });
}
