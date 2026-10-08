import { createHash } from "node:crypto";
import {
  VerificationPlanDraftSchema,
  VerificationPlanningInputSchema,
  type VerificationCheckDraft,
  type VerificationPlanDraft,
  type VerificationPlanningInput,
} from "@caelush/protocol";

export const DEFAULT_VERIFICATION_PLANNER_VERSION = "phase-11a.v2";

type VerificationPlanHashInput = Pick<
  VerificationPlanDraft,
  "sourceStepId" | "plannerVersion" | "checks"
>;

function canonicalPlanContent(input: VerificationPlanHashInput): string {
  return JSON.stringify({
    sourceStepId: input.sourceStepId,
    plannerVersion: input.plannerVersion,
    checks: input.checks.map((check) => ({
      ordinal: check.ordinal,
      stage: check.stage,
      requirement: check.requirement,
      spec: check.spec,
    })),
  });
}

export function computeVerificationPlanHash(input: VerificationPlanHashInput): string {
  return createHash("sha256").update(canonicalPlanContent(input), "utf8").digest("hex");
}

function projectChecks(): VerificationCheckDraft[] {
  return [
    {
      ordinal: 0,
      stage: "FAST_STATIC",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose: "LINT", source: "SYSTEM" },
    },
    {
      ordinal: 1,
      stage: "FAST_STATIC",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose: "TYPECHECK", source: "SYSTEM" },
    },
    {
      ordinal: 2,
      stage: "BEHAVIORAL",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose: "TEST", source: "SYSTEM" },
    },
    {
      ordinal: 3,
      stage: "BROAD",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose: "BUILD", source: "SYSTEM" },
    },
  ];
}

function normalizeRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizePackageDirectory(value: string): string | undefined {
  if (value.replaceAll("\\", "/") === ".") return ".";
  return normalizeRelativePath(value);
}

function packageForChangedPath(
  changedPath: string,
  packageDirectories: readonly string[],
): string | undefined {
  const normalizedPath = normalizeRelativePath(changedPath);
  if (normalizedPath === undefined) return undefined;
  const candidates = packageDirectories
    .map(normalizePackageDirectory)
    .filter((directory): directory is string => directory !== undefined)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  return candidates.find(
    (directory) =>
      directory === "." ||
      normalizedPath === directory ||
      normalizedPath.startsWith(`${directory}/`),
  );
}

function rawPackageDirectory(changedPath: string): string | undefined {
  const normalized = normalizeRelativePath(changedPath);
  if (normalized === undefined) return undefined;
  return /^(?:apps|packages)\/[^/]+/.exec(normalized)?.[0];
}

function isArchitectureBoundaryChange(changedPath: string): boolean {
  const normalized = normalizeRelativePath(changedPath);
  if (normalized === undefined) return false;
  return (
    normalized === "package.json" ||
    normalized === "pnpm-workspace.yaml" ||
    normalized === "pnpm-lock.yaml" ||
    /^tsconfig(?:\.[^/]+)?\.json$/.test(normalized) ||
    normalized.startsWith("scripts/architecture/") ||
    normalized.startsWith("packages/protocol/") ||
    normalized.startsWith("packages/agent/") ||
    normalized.startsWith("apps/daemon/") ||
    /^(?:apps|packages)\/[^/]+\/package\.json$/.test(normalized) ||
    /^(?:apps|packages)\/[^/]+\/src\/index\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function explicitlyRequestsFullVerification(goal: string): boolean {
  const normalized = goal.toLocaleLowerCase();
  if (
    /\b(?:do not|don't|never|skip|avoid)\b.{0,40}\b(?:full|complete|entire)\b.{0,24}\b(?:verification|validation|checks?|test suite)\b/i.test(
      normalized,
    ) ||
    /(?:不要|无需|不必|别).{0,8}(?:全量|完整).{0,5}(?:校验|检查|测试)/.test(goal)
  ) {
    return false;
  }
  return (
    /\b(?:full|complete|entire)\s+(?:project\s+)?(?:verification|validation|checks?|test suite)\b/i.test(
      normalized,
    ) || /(?:全量|完整)(?:项目)?(?:校验|检查|测试)/.test(goal)
  );
}

function appendProjectChecks(checks: VerificationCheckDraft[], packageRelativePath?: string): void {
  for (const check of projectChecks()) {
    checks.push({
      ...check,
      ordinal: checks.length,
      spec: {
        ...check.spec,
        ...(packageRelativePath === undefined ? {} : { packageRelativePath }),
      },
    });
  }
}

function appendArchitectureCheck(
  checks: VerificationCheckDraft[],
  requirement: "REQUIRED" | "IF_AVAILABLE",
): void {
  checks.push({
    ordinal: checks.length,
    stage: "FAST_STATIC",
    requirement,
    spec: { kind: "PROJECT", purpose: "ARCHITECTURE", source: "SYSTEM" },
  });
}

function explicitlyRequestsArchitectureCheck(goal: string): boolean {
  return (
    /\b(?:run|execute|perform)\s+(?:the\s+)?architecture\s+(?:check|verification)\b/i.test(goal) ||
    /(?:运行|执行|进行)(?:一下)?(?:项目)?架构(?:检查|校验|验证)/.test(goal)
  );
}

function architectureRequirement(
  input: VerificationPlanningInput,
): "REQUIRED" | "IF_AVAILABLE" | undefined {
  if (explicitlyRequestsArchitectureCheck(input.goal)) return "REQUIRED";
  const facts = input.projectFacts;
  if (facts?.architecturePolicy === "REQUIRED") return "REQUIRED";
  if (facts?.architecturePolicy === "NOT_APPLICABLE") return undefined;
  if (facts?.architecturePolicy === "IF_AVAILABLE") return "IF_AVAILABLE";
  return facts?.architectureCheckAvailable === true ? "IF_AVAILABLE" : undefined;
}

export interface VerificationPlanner {
  plan(input: VerificationPlanningInput): VerificationPlanDraft;
}

export class DefaultVerificationPlanner implements VerificationPlanner {
  readonly plannerVersion: string;

  constructor(plannerVersion = DEFAULT_VERIFICATION_PLANNER_VERSION) {
    this.plannerVersion = plannerVersion;
  }

  plan(input: VerificationPlanningInput): VerificationPlanDraft {
    const planningInput = VerificationPlanningInputSchema.parse(input);
    const checks: VerificationCheckDraft[] = [];
    const facts = planningInput.projectFacts;
    const hasRunChanges = planningInput.changedFiles.length > 0;
    const fullVerificationRequested = explicitlyRequestsFullVerification(planningInput.goal);
    const architectureCheckRequirement = architectureRequirement(planningInput);
    const runPaths = planningInput.changedFiles.map((file) => file.path);
    const hasCodeProject = facts?.isCodeProject !== false || fullVerificationRequested;

    if (fullVerificationRequested && hasCodeProject) {
      if (architectureCheckRequirement !== undefined) {
        appendArchitectureCheck(checks, architectureCheckRequirement);
      }
      appendProjectChecks(checks);
    } else if (hasRunChanges && hasCodeProject) {
      const packageDirectories = facts?.packageDirectories;
      const affectedPackages =
        packageDirectories === undefined
          ? undefined
          : runPaths.map((changedPath) => packageForChangedPath(changedPath, packageDirectories));
      const scopeIsKnown =
        affectedPackages !== undefined &&
        affectedPackages.every((directory) => directory !== undefined);

      if (!scopeIsKnown) {
        const rawDirectories = new Set(runPaths.map(rawPackageDirectory).filter(Boolean));
        if (
          architectureCheckRequirement !== undefined &&
          (rawDirectories.size > 1 || runPaths.some(isArchitectureBoundaryChange))
        ) {
          appendArchitectureCheck(checks, architectureCheckRequirement);
        }
        appendProjectChecks(checks);
      } else {
        const directories = [...new Set(affectedPackages)].sort((left, right) =>
          (left ?? "").localeCompare(right ?? ""),
        ) as string[];
        const architectureChange =
          directories.length > 1 || runPaths.some(isArchitectureBoundaryChange);
        if (architectureChange && architectureCheckRequirement !== undefined) {
          appendArchitectureCheck(checks, architectureCheckRequirement);
        }
        for (const directory of directories) appendProjectChecks(checks, directory);
      }
    }
    if (hasRunChanges) {
      checks.push({
        ordinal: checks.length,
        stage: "CHANGE_REVIEW",
        requirement: "REQUIRED",
        spec: { kind: "WORKSPACE", purpose: "CHANGESET_SANITY", source: "SYSTEM" },
      });
    }
    if ((hasRunChanges || fullVerificationRequested) && facts?.isGitRepository !== false) {
      checks.push({
        ordinal: checks.length,
        stage: "CHANGE_REVIEW",
        requirement: facts?.isGitRepository === true ? "REQUIRED" : "IF_AVAILABLE",
        spec: { kind: "GIT", purpose: "CHANGESET_REVIEW", source: "SYSTEM" },
      });
    }
    checks.push({
      ordinal: checks.length,
      stage: "ACCEPTANCE",
      requirement: "REQUIRED",
      spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
    });

    const draft = {
      runId: planningInput.runId,
      sourceStepId: planningInput.sourceStepId,
      plannerVersion: this.plannerVersion,
      planHash: computeVerificationPlanHash({
        sourceStepId: planningInput.sourceStepId,
        plannerVersion: this.plannerVersion,
        checks,
      }),
      checks,
    };
    return VerificationPlanDraftSchema.parse(draft);
  }
}
