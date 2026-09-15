import {
  RunExecutionInvariantError,
  type CompletionGate,
  type ToolTurnCoordinator,
} from "@caelush/agent";

/**
 * The deferred and misrouted Run execution driver ports.
 *
 * ```text
 * ADVANCE_AGENT        real, Phase 3C
 * EXECUTE_TOOL_BATCH   real, Phase 3D — the run-scoped adapter in run-tool-turn-coordinator.ts
 * EVALUATE_COMPLETION  Phase 3E
 * ```
 *
 * The frozen `RunExecutionDriver` requires all three collaborators. Phase 3C wired only the Agent
 * one for real and left two explicit fail-closed placeholders; Phase 3D replaced the Tool one with
 * a real adapter, so what remains here is:
 *
 * ```text
 * MISROUTED_TOOL_TURN_COORDINATOR  a Tool directive reaching an *Agent* driver
 * DEFERRED_COMPLETION_GATE         the Phase 3E completion adapter, which does not exist yet
 * ```
 *
 * They are different failures and are named differently. The completion gate is a **deferred**
 * port: nobody has implemented it, the production Run Layer evaluates completion through its
 * existing verification compatibility authority, and reaching the placeholder is a routing bug
 * that Phase 3E closes. The Tool coordinator here is a **misroute** guard: the real Tool adapter
 * exists and is what the Run Layer drives, so a Tool directive arriving at an Agent driver means
 * the wrong effect path was taken — and executing Tools from there would be a second Tool
 * execution authority.
 *
 * Neither returns a value. A placeholder that silently did nothing — or that approximated Tool
 * execution or completion — would be far worse than a throw: it would let a Run Layer believe work
 * had happened. Both are proven to be called zero times in the production end-to-end tests.
 */

/**
 * The refusal an *Agent* driver answers a Tool directive with.
 *
 * The Agent path never receives an `EXECUTE_TOOL_BATCH` directive: the Run Layer's own Tool turn
 * drives those, through the real run-scoped adapter. This port exists only because the frozen
 * driver contract requires one, and it fails closed rather than becoming a second execution path.
 */
export const MISROUTED_TOOL_TURN_COORDINATOR: ToolTurnCoordinator = {
  async execute(): Promise<never> {
    throw new RunExecutionInvariantError(
      "A Tool directive reached the Agent driver; the Run Layer owns Tool execution.",
    );
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
