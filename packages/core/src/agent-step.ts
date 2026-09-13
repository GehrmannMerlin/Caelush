/**
 * The durable Step lifecycle, re-exported from the kernel that now owns it.
 *
 * Phase 3C moved the canonical implementation into `@caelush/agent`'s Run Layer, because one
 * settled model turn is one `AgentStep` and the Step lifecycle is a statement about the Run
 * domain rather than about this host. What remains here is the name the Run Layer already
 * imports: a re-export is a compatibility surface, not a second implementation.
 */
export {
  cancelAgentStep,
  completeAgentStep,
  createRunningAgentStep,
  failAgentStep,
  nextAgentStepSequence,
} from "@caelush/agent";
export type { CompleteAgentStepInput, CreateRunningAgentStepInput } from "@caelush/agent";
