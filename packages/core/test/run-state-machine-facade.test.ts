import { describe, expect, it } from "vitest";
import {
  assertRunStatusTransition,
  canTransitionRunStatus,
  InvalidRunStatusTransitionError,
  isTerminalRunStatus,
  RUN_STATUS_TRANSITIONS,
} from "@caelush/agent";
import {
  assertRunStatusTransition as coreAssert,
  canTransitionRunStatus as coreCan,
  InvalidRunStatusTransitionError as CoreInvalid,
  isTerminalRunStatus as coreTerminal,
  RUN_STATUS_TRANSITIONS as coreTransitions,
} from "../src/run-state-machine.js";

/**
 * The Core state-machine facade is a re-export, not a second declaration.
 *
 * The distinction is not cosmetic. Two declarations would mean two identities: a `catch` that
 * matched one error class would silently miss the other, and the two matrices would be free to
 * drift apart with nothing failing. Identity comparison is the only assertion that can tell a
 * re-export from a copy, so that is what is asserted here.
 */
describe("Core Run state machine facade", () => {
  it("re-exports the kernel's objects rather than copying them", () => {
    expect(coreTransitions).toBe(RUN_STATUS_TRANSITIONS);
    expect(coreCan).toBe(canTransitionRunStatus);
    expect(coreAssert).toBe(assertRunStatusTransition);
    expect(coreTerminal).toBe(isTerminalRunStatus);
    expect(CoreInvalid).toBe(InvalidRunStatusTransitionError);
  });

  it("throws the kernel's error class, so Core's callers keep their catch", () => {
    try {
      coreAssert("COMPLETED", "RUNNING");
      expect.unreachable("a settled Run must not reopen");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRunStatusTransitionError);
      expect(error).toBeInstanceOf(CoreInvalid);
    }
  });
});
