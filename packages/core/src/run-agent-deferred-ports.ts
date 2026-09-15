import {
  RunExecutionInvariantError,
  type CompletionGate,
  type ToolTurnCoordinator,
} from "@caelush/agent";

/**
 * The deferred Run execution driver ports.
 *
 * ```text
 * ADVANCE_AGENT        real, this phase
 * EXECUTE_TOOL_BATCH   Phase 3D
 * EVALUATE_COMPLETION  Phase 3E
 * ```
 *
 * The frozen `RunExecutionDriver` requires all three collaborators, and Phase 3C wires only the
 * Agent one for real. These are the two **explicit fail-closed placeholders** the driver is
 * constructed with: reaching either of them is a routing bug, not a missing feature, because the
 * production Run Layer still performs Tool batches and completion evaluation through their
 * existing Phase 3D / Phase 3E compatibility authorities and never hands those directives to the
 * driver.
 *
 * A placeholder that silently did nothing — or that approximated Tool execution or completion —
 * would be far worse than a throw: it would let a Run Layer believe work had happened. So each
 * throws, names the phase that owns it, and is proven to have been called zero times in the
 * production end-to-end tests.
 */

/** The `EXECUTE_TOOL_BATCH` placeholder. Phase 3D owns the real Tool driver adapter. */
export const DEFERRED_TOOL_TURN_COORDINATOR: ToolTurnCoordinator = {
  async execute(): Promise<never> {
    throw new RunExecutionInvariantError("Tool RunExecutionDriver adapter belongs to Phase 3D.");
  },
};

/** The `EVALUATE_COMPLETION` placeholder. Phase 3E owns the real completion adapter. */
export const DEFERRED_COMPLETION_GATE: CompletionGate = {
  id: "deferred-phase-3e-completion-gate",
  async evaluate(): Promise<never> {
    throw new RunExecutionInvariantError(
      "Completion RunExecutionDriver adapter belongs to Phase 3E.",
    );
  },
};
