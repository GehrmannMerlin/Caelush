export const TASK_PLAN_EVIDENCE_STATES = [
  "PASSED",
  "FAILED",
  "STALE",
  "INCOMPLETE",
  "UNKNOWN",
  "UNVERIFIED",
] as const;

export type TaskPlanEvidenceState = (typeof TASK_PLAN_EVIDENCE_STATES)[number];
export type TaskPlanEvidenceKind = "MESSAGE" | "OBSERVATION" | "VERIFICATION";
export type TaskPlanEvidenceOutcome =
  | "UNVERIFIED"
  | "RUNNING"
  | "EXITED_OK"
  | "EXITED_NONZERO"
  | "TERMINATED"
  | "TOOL_FAILED"
  | "CHECK_PASSED"
  | "CHECK_FAILED"
  | "CHECK_RUNNING"
  | "CHECK_INCOMPLETE"
  | "UNKNOWN";

export interface TaskPlanEvidenceIdentity {
  readonly sessionId: string;
  readonly runId: string;
}

/** A narrow fact projection assembled by the host from its authoritative stores. */
export interface TaskPlanEvidenceFact {
  readonly reference: string;
  readonly kind: TaskPlanEvidenceKind;
  readonly sessionId: string;
  readonly runId: string;
  readonly sourceStepId?: string;
  readonly sourceCallId?: string;
  readonly observedAt: number;
  readonly outcome: TaskPlanEvidenceOutcome;
  readonly truncated?: boolean;
  readonly dependenciesKnown: boolean;
  readonly dependencies?: readonly string[];
  readonly laterMutations?: readonly { readonly at: number; readonly path?: string }[];
  readonly mutationWatermark?: number;
  readonly superseded?: boolean;
}

export interface ResolvedTaskPlanEvidence {
  readonly reference: string;
  readonly kind: TaskPlanEvidenceKind;
  readonly state: TaskPlanEvidenceState;
}

const REF_PATTERN = /^(message|observation|verification):([A-Za-z0-9._-]{1,128})$/u;

/**
 * Resolve bounded model references against already-authorized host facts.
 * Unknown, cross-Run, cross-Session, malformed and missing references never become evidence.
 */
export function resolveTaskPlanEvidence(input: {
  readonly identity: TaskPlanEvidenceIdentity;
  readonly refs: readonly string[];
  readonly facts: readonly TaskPlanEvidenceFact[];
}): readonly ResolvedTaskPlanEvidence[] {
  const facts = new Map(input.facts.map((fact) => [fact.reference, fact]));
  return Object.freeze(
    input.refs.map((reference) => {
      const match = REF_PATTERN.exec(reference);
      if (match === null) {
        return {
          reference: boundedReference(reference),
          kind: "MESSAGE" as const,
          state: "UNKNOWN" as const,
        };
      }
      const kind = parseKind(match[1]);
      const fact = facts.get(reference);
      if (
        fact === undefined ||
        fact.kind !== kind ||
        fact.runId !== input.identity.runId ||
        fact.sessionId !== input.identity.sessionId ||
        !Number.isSafeInteger(fact.observedAt) ||
        !outcomeMatchesKind(kind, fact.outcome)
      ) {
        return { reference, kind, state: "UNKNOWN" as const };
      }
      return { reference, kind, state: stateForFact(fact) };
    }),
  );
}

export function aggregateTaskPlanEvidenceState(
  refs: readonly string[] | undefined,
  resolved: ReadonlyMap<string, TaskPlanEvidenceState>,
): TaskPlanEvidenceState {
  if (refs === undefined || refs.length === 0) return "UNVERIFIED";
  const states = refs.map((reference) => resolved.get(reference) ?? "UNKNOWN");
  if (states.includes("FAILED")) return "FAILED";
  if (states.includes("STALE")) return "STALE";
  if (states.includes("INCOMPLETE")) return "INCOMPLETE";
  if (states.includes("UNKNOWN")) return "UNKNOWN";
  if (states.every((state) => state === "PASSED")) return "PASSED";
  return "UNVERIFIED";
}

function stateForFact(fact: TaskPlanEvidenceFact): TaskPlanEvidenceState {
  if (
    fact.outcome === "EXITED_NONZERO" ||
    fact.outcome === "TERMINATED" ||
    fact.outcome === "TOOL_FAILED" ||
    fact.outcome === "CHECK_FAILED"
  ) {
    return "FAILED";
  }
  if (fact.superseded === true && fact.outcome === "CHECK_PASSED") return "STALE";
  if (
    fact.outcome === "RUNNING" ||
    fact.outcome === "CHECK_RUNNING" ||
    fact.outcome === "UNKNOWN"
  ) {
    return "UNKNOWN";
  }
  if (fact.outcome === "CHECK_INCOMPLETE" || fact.truncated === true) return "INCOMPLETE";
  if (fact.outcome === "CHECK_PASSED") {
    if (!fact.dependenciesKnown) {
      return (fact.mutationWatermark ?? 0) > fact.observedAt ? "STALE" : "PASSED";
    }
    if (
      (fact.laterMutations ?? []).some((mutation) => {
        if (mutation.path === undefined) return true;
        const mutationPath = mutation.path;
        return (
          fact.dependencies?.some((dependency) => pathsOverlap(dependency, mutationPath)) === true
        );
      })
    ) {
      return "STALE";
    }
    return "PASSED";
  }
  // A message, successful Tool call, or zero-exit shell command is not a verification result.
  return "UNVERIFIED";
}

function parseKind(value: string | undefined): TaskPlanEvidenceKind {
  switch (value) {
    case "observation":
      return "OBSERVATION";
    case "verification":
      return "VERIFICATION";
    default:
      return "MESSAGE";
  }
}

function outcomeMatchesKind(kind: TaskPlanEvidenceKind, outcome: TaskPlanEvidenceOutcome): boolean {
  if (kind === "VERIFICATION") return outcome.startsWith("CHECK_") || outcome === "UNKNOWN";
  if (kind === "MESSAGE") return outcome === "UNVERIFIED" || outcome === "UNKNOWN";
  return (
    outcome !== "CHECK_PASSED" &&
    outcome !== "CHECK_FAILED" &&
    outcome !== "CHECK_RUNNING" &&
    outcome !== "CHECK_INCOMPLETE"
  );
}

function pathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function boundedReference(value: string): string {
  return value.slice(0, 160);
}
