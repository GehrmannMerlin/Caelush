import type {
  ResourceActivePatternRecord,
  ResourceProgressRecordV1,
  RunResourcePolicy,
} from "@caelush/protocol";

import type {
  ResourceProgressPattern,
  ResourceProgressTurn,
} from "./resource-progress-classifier.js";

/**
 * How many accepted Tool batches the semantic window keeps.
 *
 * Historical V1 constant, kept only as the value a *legacy* ledger was written with. Every decision
 * made now reads `policy.progress.windowTurns`, so a host that configured a different horizon gets
 * that horizon — and a Run keeps the one it froze at creation.
 */
export const RESOURCE_PROGRESS_WINDOW_TURNS = 8;

/** Historical V1 occurrence threshold before the model is told what is wrong. */
export const RESOURCE_PROGRESS_NUDGE_AFTER = 3;

/** Historical V1 occurrence threshold before the batch is re-planned instead of run. */
export const RESOURCE_PROGRESS_REPLAN_AFTER = 4;

/** Historical V1 re-plans before the Run waits for a human decision. */
export const RESOURCE_PROGRESS_MAX_REPLANS = 2;

/**
 * The thresholds one decision is made with.
 *
 * ```text
 * windowTurns                  how many accepted batches count as "current behaviour"
 * nudgeAfterOccurrences        occurrences of one pattern before the model is told
 * reviewAfterOccurrences       occurrences before the model is asked to re-examine its approach
 * replanAfterOccurrences       V1 only: occurrences before a batch is refused and re-planned
 * replansBeforePause           V1 only: re-plans before a human decision is required
 * correctionVersion            which of the two disciplines is in force
 * ```
 *
 * Every number here comes from the Run's frozen `RunResourcePolicy`. There is deliberately no module
 * constant in the V2 path: two sources of one threshold is how a policy and its behaviour drift apart
 * without anybody editing the policy.
 */
export interface ResourceProgressPolicy {
  readonly windowTurns: number;
  readonly nudgeAfterOccurrences: number;
  readonly reviewAfterOccurrences: number;
  readonly replanAfterOccurrences: number;
  readonly replansBeforePause: number;
  readonly correctionVersion: "V1" | "V2";
}

/** Read the thresholds a Run's frozen policy defines. */
export function resourceProgressPolicyFrom(policy: RunResourcePolicy): ResourceProgressPolicy {
  return Object.freeze({
    windowTurns: policy.progress.windowTurns,
    nudgeAfterOccurrences: policy.progress.identicalCallNudgeThreshold,
    reviewAfterOccurrences: policy.progress.noProgressTurnsBeforeReplan,
    replanAfterOccurrences: RESOURCE_PROGRESS_REPLAN_AFTER,
    replansBeforePause: policy.progress.replansBeforePause,
    correctionVersion: policy.correctionVersion === "AUTONOMOUS_CORRECTION_V2" ? "V2" : "V1",
  });
}

/**
 * The policy an undecorated call site gets.
 *
 * It exists for one purpose: reading a ledger written before this policy object existed. It is the
 * historical V1 discipline with the historical constants, and no production path selects it —
 * `RunToolTurnDriverDependencies` always carries the Run's frozen policy.
 */
export const LEGACY_RESOURCE_PROGRESS_POLICY: ResourceProgressPolicy = Object.freeze({
  windowTurns: RESOURCE_PROGRESS_WINDOW_TURNS,
  nudgeAfterOccurrences: RESOURCE_PROGRESS_NUDGE_AFTER,
  reviewAfterOccurrences: RESOURCE_PROGRESS_REPLAN_AFTER,
  replanAfterOccurrences: RESOURCE_PROGRESS_REPLAN_AFTER,
  replansBeforePause: RESOURCE_PROGRESS_MAX_REPLANS,
  correctionVersion: "V1",
});

/** The active repeated-failure episode, or nothing when no pattern is recurring. */
export type ResourceActivePattern = ResourceActivePatternRecord;

/**
 * The derived semantic progress of one Run.
 *
 * It is a projection over accepted `TOOL_RESULT` facts: nothing here is a second execution ledger,
 * and recomputing it from the same turns yields the same value. The durable shape is the protocol's
 * record so Storage and Core cannot drift apart.
 */
export type ResourceSemanticProgress = ResourceProgressRecordV1;

/**
 * Which corrective step an episode has reached.
 *
 * ```text
 * INPUT_CORRECTION     the fields the schema rejected, and nothing else
 * REVIEW_APPROACH      the same mistake survived the first correction: re-read the goal and the step
 * REBUILD_WORK_STATE   the same mistake survived two: rebuild the working record before continuing
 * ```
 *
 * The ladder is advice, not a gate. Reaching the last rung does not stop anything; it changes what the
 * model is told.
 */
export type ResourceCorrectionStage =
  | "INPUT_CORRECTION"
  | "REVIEW_APPROACH"
  | "REBUILD_WORK_STATE";

export type ResourceSemanticDecision =
  | { readonly kind: "NONE" }
  | {
      readonly kind: "NUDGE";
      readonly stage: ResourceCorrectionStage;
      readonly patternKey: string;
      readonly toolName: string;
      readonly code: string;
      readonly occurrences: number;
      /** How many interventions were already delivered when this decision was made. */
      readonly deliveredInterventions: number;
    }
  | {
      readonly kind: "REPLAN";
      readonly patternKey: string;
      readonly toolName: string;
      readonly code: string;
      readonly occurrences: number;
    }
  | {
      readonly kind: "WAITING_RESOURCE";
      readonly patternKey: string;
      readonly toolName: string;
      readonly code: string;
      readonly occurrences: number;
    };

/** The most recent stored form of a pattern, for guidance text. */
export function findResourceProgressPattern(
  progress: ResourceSemanticProgress,
  key: string,
): ResourceProgressPattern | undefined {
  for (let index = progress.turns.length - 1; index >= 0; index -= 1) {
    const found = progress.turns[index]!.patterns.find((pattern) => pattern.key === key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function emptyResourceSemanticProgress(): ResourceSemanticProgress {
  return Object.freeze({ version: 1 as const, turns: Object.freeze([]) });
}

/**
 * Fold one accepted batch into the window.
 *
 * Idempotent by construction: a turn whose message is already recorded is not counted twice, so a
 * retried post-commit update after a crash cannot inflate the evidence.
 */
export function applyResourceProgressTurn(
  policy: ResourceProgressPolicy,
  progress: ResourceSemanticProgress,
  turn: ResourceProgressTurn,
): ResourceSemanticProgress {
  if (progress.turns.some((existing) => existing.turnId === turn.turnId)) return progress;
  // A prepared-but-undelivered correction survives a window fold: folding evidence says nothing about
  // whether the model has been told, and dropping the advice here would silently cancel it.
  const pending = progress.correction === undefined ? {} : { correction: progress.correction };
  const turns = Object.freeze([...progress.turns, turn].slice(-policy.windowTurns));
  const active = progress.active;
  if (active === undefined) {
    const candidate = mostFrequentPattern(turns);
    if (candidate === undefined || candidate.occurrences < policy.nudgeAfterOccurrences) {
      return Object.freeze({ version: 1 as const, turns, ...pending });
    }
    return Object.freeze({
      version: 1 as const,
      turns,
      ...pending,
      active: Object.freeze({
        key: candidate.pattern.key,
        toolName: candidate.pattern.toolName,
        code: candidate.pattern.code,
        replans: 0,
        nudged: false,
        deliveredInterventions: 0,
      }),
    });
  }

  const start = startIndex(turns, active.sinceTurnId);
  if (start === undefined) {
    // The episode's starting point fell out of the window: the pattern is no longer recent enough to
    // escalate, so the episode ends instead of counting forever.
    return Object.freeze({ version: 1 as const, turns, ...pending });
  }
  if (countPattern(turns, active) === 0) {
    // The pattern itself has fallen out of the window. Keeping the episode alive would let an old
    // mistake escalate on evidence nobody can see any more.
    return Object.freeze({ version: 1 as const, turns, ...pending });
  }
  const resolved = turns
    .slice(start)
    .some((candidate) => candidate.succeededTools.includes(active.toolName));
  if (resolved) return Object.freeze({ version: 1 as const, turns, ...pending });
  return Object.freeze({ version: 1 as const, turns, ...pending, active });
}

/**
 * Decide whether the current window warrants an intervention.
 *
 * The decision is a pure function of the window, the episode counters and the frozen thresholds. It
 * never consults a clock, so "the task has been running for 95 minutes" can never become the reason
 * for stopping it.
 *
 * ## The two disciplines
 *
 * ```text
 * V1   nudge -> re-plan -> wait for a human decision, after `replansBeforePause` re-plans
 * V2   nudge -> review -> rebuild, and never a wait: the current batch is admitted either way
 * ```
 *
 * V2 is not a louder V1. It removes the *gate*: a batch is admitted on the strength of the call in
 * front of it, never on the strength of the Run's history. What history buys is better advice, which is
 * delivered through Context and consumed by the next model decision. That is the only place advice can
 * change behaviour without also cancelling a call that may already be correct — the case the incident
 * hit at step 76, where a corrected `patch` argument was refused because two earlier attempts had
 * failed.
 */
export function decideResourceSemanticIntervention(
  policy: ResourceProgressPolicy,
  progress: ResourceSemanticProgress,
): ResourceSemanticDecision {
  const active = progress.active;
  if (active === undefined) return Object.freeze({ kind: "NONE" as const });
  const occurrences = countPattern(progress.turns, active);

  if (policy.correctionVersion === "V2") {
    return decideAutonomousCorrection(active, occurrences, policy);
  }

  if (occurrences >= policy.replanAfterOccurrences) {
    return Object.freeze({
      kind: active.replans >= policy.replansBeforePause ? "WAITING_RESOURCE" : "REPLAN",
      patternKey: active.key,
      toolName: active.toolName,
      code: active.code,
      occurrences,
    });
  }
  if (occurrences >= policy.nudgeAfterOccurrences && !active.nudged) {
    return Object.freeze({
      kind: "NUDGE" as const,
      stage: "INPUT_CORRECTION" as const,
      patternKey: active.key,
      toolName: active.toolName,
      code: active.code,
      occurrences,
      deliveredInterventions: deliveredInterventionsOf(active),
    });
  }
  return Object.freeze({ kind: "NONE" as const });
}

/**
 * The V2 ladder: escalate the *advice* while the same mistake recurs, and stop escalating after the
 * strongest rung has been delivered once.
 *
 * The next rung is chosen by how many corrections have actually been delivered, not by how many times
 * the pattern was detected. A detection whose request never settled is retried at the same rung, which
 * is why a lost provider turn no longer silently consumes an escalation step.
 */
function decideAutonomousCorrection(
  active: ResourceActivePattern,
  occurrences: number,
  policy: ResourceProgressPolicy,
): ResourceSemanticDecision {
  if (occurrences < policy.nudgeAfterOccurrences) return Object.freeze({ kind: "NONE" as const });
  const delivered = deliveredInterventionsOf(active);
  const stage = correctionStage(occurrences, delivered, policy);
  if (stage === undefined) return Object.freeze({ kind: "NONE" as const });
  return Object.freeze({
    kind: "NUDGE" as const,
    stage,
    patternKey: active.key,
    toolName: active.toolName,
    code: active.code,
    occurrences,
    deliveredInterventions: delivered,
  });
}

function correctionStage(
  occurrences: number,
  delivered: number,
  policy: ResourceProgressPolicy,
): ResourceCorrectionStage | undefined {
  if (delivered === 0) return "INPUT_CORRECTION";
  if (delivered === 1) return "REVIEW_APPROACH";
  if (delivered === 2 && occurrences >= policy.reviewAfterOccurrences) {
    return "REBUILD_WORK_STATE";
  }
  return undefined;
}

/** How many interventions this episode has actually delivered. */
export function deliveredInterventionsOf(active: ResourceActivePattern): number {
  if (active.deliveredInterventions !== undefined) return active.deliveredInterventions;
  // A record written before deliveries were counted: the V1 acknowledgement is the only evidence of
  // one delivery that exists, and it must not be counted as zero (that would re-send the first rung
  // forever) nor as more than one.
  return active.nudged ? 1 : 0;
}

/**
 * Record that one corrective intervention reached a settled model request.
 *
 * ```text
 * detected    decideResourceSemanticIntervention returned a stage
 * prepared    the correction entered the Context this request was built from
 * delivered   the model result bound to that request committed — this function
 * ```
 *
 * This is the only transition that advances the ladder, and it is called from the settlement of a
 * model turn, never from the recording of a Tool result. Recording a *detection* as a delivery was the
 * defect this replaces: the ledger claimed the model had been told while the guidance had already been
 * dropped on the way out, so the reminder was never repeated and never arrived.
 *
 * It also retires the pending correction, and only when the delivered identity is the one that is
 * pending — a stale receipt for an older intervention cannot clear a newer one.
 */
export function recordResourceNudgeDelivery(
  progress: ResourceSemanticProgress,
  deliveredInterventionId?: string,
): ResourceSemanticProgress {
  const active = progress.active;
  if (active === undefined) return progress;
  if (
    deliveredInterventionId !== undefined &&
    progress.correction !== undefined &&
    progress.correction.interventionId !== deliveredInterventionId
  ) {
    return progress;
  }
  const delivered = deliveredInterventionsOf(active);
  return Object.freeze({
    version: 1 as const,
    turns: progress.turns,
    active: Object.freeze({
      ...active,
      nudged: true,
      deliveredInterventions: delivered + 1,
    }),
  });
}

/**
 * Record the V1 reminder acknowledgement.
 *
 * The historical discipline taught nothing about delivery, so its reminder state *is* the counter: a
 * nudge is retired the moment the result that produced it is accepted, and the same advice is not
 * repeated. That is weaker than V2 and it is kept exactly as it was, because a Run's evidence must keep
 * meaning what it meant when it was gathered.
 *
 * V2 must not call this from result recording — see {@link recordResourceNudgeDelivery}.
 */
export function acknowledgeV1ResourceNudge(
  progress: ResourceSemanticProgress,
): ResourceSemanticProgress {
  const active = progress.active;
  if (active === undefined || active.nudged) return progress;
  return Object.freeze({
    version: 1 as const,
    turns: progress.turns,
    ...(progress.correction === undefined ? {} : { correction: progress.correction }),
    active: Object.freeze({ ...active, nudged: true }),
  });
}

/** Start the next episode of the same pattern after a re-plan. */
export function acknowledgeResourceReplan(
  progress: ResourceSemanticProgress,
  lastTurnId: string | undefined,
): ResourceSemanticProgress {
  const active = progress.active;
  if (active === undefined) return progress;
  return Object.freeze({
    version: 1 as const,
    turns: progress.turns,
    active: Object.freeze({
      ...active,
      ...(lastTurnId === undefined ? {} : { sinceTurnId: lastTurnId }),
      replans: active.replans + 1,
      nudged: false,
    }),
  });
}

/** Read the pattern key and counters a checkpoint or a context contribution needs. */
export function resourceSemanticSummary(progress: ResourceSemanticProgress): {
  readonly activePatternKey?: string;
  readonly toolName?: string;
  readonly code?: string;
  readonly occurrences: number;
  readonly replans: number;
  readonly deliveredInterventions: number;
} {
  const active = progress.active;
  if (active === undefined) return { occurrences: 0, replans: 0, deliveredInterventions: 0 };
  return {
    activePatternKey: active.key,
    toolName: active.toolName,
    code: active.code,
    occurrences: countPattern(progress.turns, active),
    replans: active.replans,
    deliveredInterventions: deliveredInterventionsOf(active),
  };
}

function countPattern(
  turns: readonly ResourceProgressTurn[],
  active: ResourceActivePattern,
): number {
  // Occurrences are counted strictly after the episode boundary: the turn that produced a re-plan is
  // the evidence for that re-plan, not the first occurrence of the next episode. With no boundary the
  // whole window counts, which is the first episode.
  const from = startIndex(turns, active.sinceTurnId) ?? 0;
  let count = 0;
  for (let index = from; index < turns.length; index += 1) {
    if (turns[index]!.patterns.some((pattern) => pattern.key === active.key)) count += 1;
  }
  return count;
}

/**
 * Where counting starts for an episode.
 *
 * `undefined` means the boundary turn is no longer in the window; a missing boundary means the whole
 * window counts.
 */
function startIndex(
  turns: readonly ResourceProgressTurn[],
  sinceTurnId: string | undefined,
): number | undefined {
  if (sinceTurnId === undefined) return 0;
  const index = turns.findIndex((turn) => turn.turnId === sinceTurnId);
  return index < 0 ? undefined : index + 1;
}

/** The most frequent pattern in the window, breaking ties toward the most recent evidence. */
function mostFrequentPattern(
  turns: readonly ResourceProgressTurn[],
): { readonly pattern: ResourceProgressPattern; readonly occurrences: number } | undefined {
  const counts = new Map<
    string,
    { pattern: ResourceProgressPattern; count: number; lastIndex: number }
  >();
  turns.forEach((turn, index) => {
    for (const pattern of turn.patterns) {
      const current = counts.get(pattern.key);
      counts.set(pattern.key, {
        pattern,
        count: (current?.count ?? 0) + 1,
        lastIndex: index,
      });
    }
  });
  let best: { pattern: ResourceProgressPattern; count: number; lastIndex: number } | undefined;
  for (const value of counts.values()) {
    if (
      best === undefined ||
      value.count > best.count ||
      (value.count === best.count && value.lastIndex > best.lastIndex)
    ) {
      best = value;
    }
  }
  return best === undefined ? undefined : { pattern: best.pattern, occurrences: best.count };
}
