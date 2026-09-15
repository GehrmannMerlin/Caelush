/**
 * The legacy Core Run state machine facade.
 *
 * Phase 3C moved the canonical Run state machine into `@caelush/agent`'s Run Layer, because a Run
 * status transition is a statement about the *Run* rather than about this host. This module is a
 * compatibility re-export so existing Core call sites keep their import path while the migration
 * continues.
 *
 * It declares nothing of its own. There is deliberately no second `RUN_STATUS_TRANSITIONS` and no
 * second error class: two declarations would mean two identities, and a `catch` that matched one
 * would silently miss the other.
 */
export {
  assertRunStatusTransition,
  canTransitionRunStatus,
  InvalidRunStatusTransitionError,
  isTerminalRunStatus,
  RUN_STATUSES,
  RUN_STATUS_TRANSITIONS,
} from "@caelush/agent";
