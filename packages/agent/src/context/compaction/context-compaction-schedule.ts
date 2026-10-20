/**
 * When proactive compaction may run.
 *
 * ```text
 * pressure ratio        estimate / effective input limit
 * proactive ratio       cross it and a compaction is *attempted* (not merely labelled)
 * emergency ratio       cross it and the normal cooldown is bypassed
 * rearm ratio           fall back below it before another ordinary attempt is allowed
 * cooldown turns        minimum new model turns between ordinary attempts
 * ```
 *
 * The failure this exists for: the pressure evaluator classified `PROACTIVE` at 75% but never
 * compacted, because the only conditions that set `shouldCompact` were "already at the limit" and
 * "history selection failed". A Run therefore sailed past every warning and stopped at the structural
 * bound with no summarisation ever attempted.
 *
 * The state is deliberately tiny and derived: it paces attempts, it is never an authority. Losing it
 * costs at most one extra attempt, and every attempt still goes through the existing planner,
 * validator, gain gate and compaction transaction.
 */

export interface ContextCompactionSchedulePolicy {
  readonly rearmRatio: number;
  readonly cooldownTurns: number;
}

/** The state that makes the ladder hysteretic instead of a per-turn coin flip. */
export interface ContextCompactionSchedule {
  readonly armed: boolean;
  readonly cooldownTurnsRemaining: number;
}

export const DEFAULT_CONTEXT_COMPACTION_SCHEDULE_POLICY: ContextCompactionSchedulePolicy =
  Object.freeze({ rearmRatio: 0.65, cooldownTurns: 4 });

export function initialContextCompactionSchedule(): ContextCompactionSchedule {
  return Object.freeze({ armed: true, cooldownTurnsRemaining: 0 });
}

/**
 * Advance the schedule for one model turn.
 *
 * `compacted` means the turn actually attempted a compaction (whether or not it produced a
 * checkpoint). A failed or gainless attempt still starts the cooldown: retrying the same input with
 * the same strategy is what turns one bad decision into a loop.
 */
export function advanceContextCompactionSchedule(
  schedule: ContextCompactionSchedule,
  input: {
    readonly pressureRatio: number;
    readonly emergency: boolean;
    readonly forced: boolean;
    readonly compacted: boolean;
  },
  policy: ContextCompactionSchedulePolicy = DEFAULT_CONTEXT_COMPACTION_SCHEDULE_POLICY,
): ContextCompactionSchedule {
  const cooldown = Math.max(0, schedule.cooldownTurnsRemaining - 1);
  if (input.compacted) {
    return Object.freeze({ armed: false, cooldownTurnsRemaining: policy.cooldownTurns });
  }
  if (input.forced || input.emergency) {
    // Emergency and provider overflow are not ordinary attempts: hysteresis and cooldown exist to
    // pace elective work, not to refuse a window that is already failing.
    return Object.freeze({ armed: true, cooldownTurnsRemaining: cooldown });
  }
  if (input.pressureRatio <= policy.rearmRatio) {
    return Object.freeze({ armed: true, cooldownTurnsRemaining: cooldown });
  }
  return Object.freeze({ armed: schedule.armed, cooldownTurnsRemaining: cooldown });
}

/** Whether an ordinary (non-emergency, non-forced) compaction may be attempted now. */
export function contextCompactionDue(
  schedule: ContextCompactionSchedule,
  input: { readonly enabled: boolean; readonly emergency: boolean; readonly forced: boolean },
): boolean {
  if (!input.enabled) return false;
  if (input.forced || input.emergency) return true;
  return schedule.armed && schedule.cooldownTurnsRemaining === 0;
}
