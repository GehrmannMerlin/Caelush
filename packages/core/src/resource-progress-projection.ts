import type { ResourceActivePatternRecord, ResourceProgressRecordV1 } from "@caelush/protocol";

import type {
  ResourceProgressPattern,
  ResourceProgressTurn,
} from "./resource-progress-classifier.js";

/**
 * How many accepted Tool batches the semantic window keeps.
 *
 * The number matches the existing `RunResourcePolicy.progress` window, because the two describe the
 * same horizon: "recent enough that a pattern here is current behaviour". It is a window, not a
 * total, so an old mistake that has stopped happening is forgotten without anyone clearing it.
 */
export const RESOURCE_PROGRESS_WINDOW_TURNS = 8;

/** Occurrences of one pattern before the model is told what is wrong. */
export const RESOURCE_PROGRESS_NUDGE_AFTER = 3;

/** Occurrences of one pattern within an episode before the batch is re-planned instead of run. */
export const RESOURCE_PROGRESS_REPLAN_AFTER = 4;

/** How many times one pattern may be re-planned before the Run waits for a human decision. */
export const RESOURCE_PROGRESS_MAX_REPLANS = 2;

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

export type ResourceSemanticDecision =
  | { readonly kind: "NONE" }
  | {
      readonly kind: "NUDGE";
      readonly patternKey: string;
      readonly toolName: string;
      readonly code: string;
      readonly occurrences: number;
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
  progress: ResourceSemanticProgress,
  turn: ResourceProgressTurn,
): ResourceSemanticProgress {
  if (progress.turns.some((existing) => existing.turnId === turn.turnId)) return progress;
  const turns = Object.freeze([...progress.turns, turn].slice(-RESOURCE_PROGRESS_WINDOW_TURNS));
  const active = progress.active;
  if (active === undefined) {
    const candidate = mostFrequentPattern(turns);
    if (candidate === undefined || candidate.occurrences < RESOURCE_PROGRESS_NUDGE_AFTER) {
      return Object.freeze({ version: 1 as const, turns });
    }
    return Object.freeze({
      version: 1 as const,
      turns,
      active: Object.freeze({
        key: candidate.pattern.key,
        toolName: candidate.pattern.toolName,
        code: candidate.pattern.code,
        replans: 0,
        nudged: false,
      }),
    });
  }

  const start = startIndex(turns, active.sinceTurnId);
  if (start === undefined) {
    // The episode's starting point fell out of the window: the pattern is no longer recent enough to
    // escalate, so the episode ends instead of counting forever.
    return Object.freeze({ version: 1 as const, turns });
  }
  if (countPattern(turns, active) === 0) {
    // The pattern itself has fallen out of the window. Keeping the episode alive would let an old
    // mistake escalate on evidence nobody can see any more.
    return Object.freeze({ version: 1 as const, turns });
  }
  const resolved = turns
    .slice(start)
    .some((candidate) => candidate.succeededTools.includes(active.toolName));
  if (resolved) return Object.freeze({ version: 1 as const, turns });
  return Object.freeze({ version: 1 as const, turns, active });
}

/**
 * Decide whether the current window warrants an intervention.
 *
 * The decision is a pure function of the window and the episode counters. It never consults a clock,
 * so "the task has been running for 95 minutes" can never become the reason for stopping it.
 */
export function decideResourceSemanticIntervention(
  progress: ResourceSemanticProgress,
): ResourceSemanticDecision {
  const active = progress.active;
  if (active === undefined) return Object.freeze({ kind: "NONE" as const });
  const occurrences = countPattern(progress.turns, active);
  if (occurrences >= RESOURCE_PROGRESS_REPLAN_AFTER) {
    return Object.freeze({
      kind: active.replans >= RESOURCE_PROGRESS_MAX_REPLANS ? "WAITING_RESOURCE" : "REPLAN",
      patternKey: active.key,
      toolName: active.toolName,
      code: active.code,
      occurrences,
    });
  }
  if (occurrences >= RESOURCE_PROGRESS_NUDGE_AFTER && !active.nudged) {
    return Object.freeze({
      kind: "NUDGE" as const,
      patternKey: active.key,
      toolName: active.toolName,
      code: active.code,
      occurrences,
    });
  }
  return Object.freeze({ kind: "NONE" as const });
}

/** Record that the model was told about the pattern, so the same reminder is not repeated. */
export function acknowledgeResourceNudge(
  progress: ResourceSemanticProgress,
): ResourceSemanticProgress {
  const active = progress.active;
  if (active === undefined || active.nudged) return progress;
  return Object.freeze({
    version: 1 as const,
    turns: progress.turns,
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
} {
  const active = progress.active;
  if (active === undefined) return { occurrences: 0, replans: 0 };
  return {
    activePatternKey: active.key,
    toolName: active.toolName,
    code: active.code,
    occurrences: countPattern(progress.turns, active),
    replans: active.replans,
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
