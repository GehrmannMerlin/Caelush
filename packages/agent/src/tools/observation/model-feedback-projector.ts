import type { AIToolResultMessage } from "@caelush/ai";

import type { ToolObservationPolicySnapshot } from "../../loop/types.js";
import type { ToolBatchItemOutcome } from "../batch/batch-types.js";
import { AgentToolResultBatchError } from "../batch/batch-errors.js";
import type { ToolCallRequest } from "../call/tool-call-preparer.js";

/**
 * The canonical Model Tool Feedback Projector.
 *
 * ```text
 * ToolBatchItemOutcome[]     durable observations and safe failures
 *        ↓
 * token-bounded model view   one bounded text per original call
 *        ↓
 * AIToolResultMessage[]      exactly one per original call, in original order
 * ```
 *
 * ## The two, and only two, facts it may project
 *
 * ```text
 * a durable ToolObservation     the OBSERVATION arm
 * safe ToolFailureFeedback      the REJECTED and SKIPPED arms
 * ```
 *
 * There is deliberately no third input. This class never sees an `AgentToolResult`, a raw Runtime
 * stdout or stderr, a raw exception, a `ToolExecutionUpdate`, a `ToolEffect[]` or archive content —
 * a projector that accepted those could put unprojected execution detail into model history, and the
 * whole point of a durable observation is that it is the *settled, sanitized* account of what happened.
 *
 * ## Identity comes from the call, never from a string
 *
 * Every message's `toolCallId` and `toolName` are read from `item.call`, which carries the model's
 * original `ToolCallRequest`. The projector does not parse an id out of content and does not accept a
 * caller-supplied identity, so "same externalCallId, same toolName" is structural rather than checked.
 *
 * ## Bounded output
 *
 * `REJECTED` and `SKIPPED` are *safe* feedback, but safe is not the same as short: an unbounded
 * rejection message would still blow a context window, so the same observation policy bounds every
 * item — including the ones that never executed.
 *
 * ## What it deliberately does not own
 *
 * The token-projection *algorithm* is not here. `@caelush/context` owns it, and the Architecture V2
 * dependency rules forbid `agent -> context`. The projector therefore receives it as a narrow injected
 * callback ({@link ModelObservationBatchProjector}); the composition root wires the two together. That
 * keeps `@caelush/agent` authoritative over model feedback *semantics* while leaving the truncation
 * algorithm with its existing owner — and it means the head + omission-marker + tail behaviour the
 * Context projector applies to `read_file` and `exec_command`-shaped output is preserved rather than
 * silently degraded to a prefix cut.
 */
export interface ModelToolFeedbackProjector {
  project(input: {
    readonly calls: readonly ToolCallRequest[];
    readonly items: readonly ToolBatchItemOutcome[];
    readonly policy: ToolObservationPolicySnapshot;
  }): readonly AIToolResultMessage[];
}

/**
 * One candidate for the model view, before it is bounded.
 *
 * Both fields are already safe: `content` is either a durable observation's content or a safe failure's
 * content, and `rawArtifactRef` exists only so a Context projection can tell *which* artifact the raw
 * output was archived under. The reference never reaches the model — `AIToolResultMessage` has no field
 * for it — it only travels through the projection call.
 */
export interface ModelObservationCandidate {
  readonly sourceToolInvocationId: string;
  readonly toolName: string;
  readonly content: string;
  readonly rawArtifactRef?: string | undefined;
}

/**
 * The narrow token-projection seam the projector is constructed with.
 *
 * It is an *implementation* dependency, not part of the frozen `project(...)` input: a host that
 * supplies one is choosing how to bound text, not widening the contract. The composition root supplies
 * the existing Context implementation, so there is exactly one observation-budget algorithm in the
 * repository.
 *
 * Implementations must return exactly one bounded summary per candidate, in the same order, and should
 * throw rather than silently return a different count.
 */
export interface ModelObservationBatchProjector {
  projectBatch(input: {
    readonly candidates: readonly ModelObservationCandidate[];
    readonly policy: ToolObservationPolicySnapshot;
  }): readonly string[];
}

export interface ModelToolFeedbackProjectorOptions {
  /**
   * The token-projection implementation.
   *
   * Absent means the projector bounds text with its own generic proportional budget. That fallback is
   * deliberately tool-agnostic — it knows no Tool names, so it cannot reproduce the Context projector's
   * head + tail treatment for large file or command output. A production host wires the Context
   * implementation so that behaviour is preserved.
   */
  readonly projection?: ModelObservationBatchProjector | undefined;
}

/** The marker appended to text the fallback projection shortened. */
export const MODEL_FEEDBACK_TRUNCATION_MARKER = "\n[output truncated to fit the model budget]";

/** The absolute fallback when even the marker does not fit the allocated budget. */
const MINIMAL_TRUNCATION_MARKER = "[truncated]";

/**
 * Build the canonical model feedback projector.
 *
 * Stateless apart from the injected projection, so the same batch and the same policy always produce
 * the same messages.
 */
export function createModelToolFeedbackProjector(
  options: ModelToolFeedbackProjectorOptions = {},
): ModelToolFeedbackProjector {
  return {
    project(input: {
      readonly calls: readonly ToolCallRequest[];
      readonly items: readonly ToolBatchItemOutcome[];
      readonly policy: ToolObservationPolicySnapshot;
    }): readonly AIToolResultMessage[] {
      const { calls, items, policy } = input;
      assertItemBatchMatchesCalls(calls, items);
      assertProjectionPolicy(policy);
      if (calls.length === 0) return Object.freeze([]);

      const candidates = items.map((item) => candidateOf(item));
      const bounded =
        options.projection === undefined
          ? boundProportionally(candidates, policy)
          : projectThroughInjected(options.projection, candidates, policy);
      if (bounded.length !== candidates.length) {
        // A projection that returned a different number of summaries cannot be matched to calls, and
        // guessing a pairing would attach one Tool's output to another Tool's identity.
        throw new AgentToolResultBatchError("UNEXPECTED_RESULT", {
          requestCount: candidates.length,
          resultCount: bounded.length,
        });
      }

      return Object.freeze(
        items.map((item, index) =>
          Object.freeze({
            role: "tool" as const,
            // Identity is read from the original call: never parsed, never supplied by the projection.
            toolCallId: item.call.externalCallId,
            toolName: item.call.toolName,
            content: bounded[index] ?? "",
            isError: isErrorOf(item),
          }),
        ),
      );
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Projection
 * ---------------------------------------------------------------------------------------------- */

function projectThroughInjected(
  projection: ModelObservationBatchProjector,
  candidates: readonly ModelObservationCandidate[],
  policy: ToolObservationPolicySnapshot,
): readonly string[] {
  let projected: readonly string[];
  try {
    projected = projection.projectBatch({ candidates, policy });
  } catch (error) {
    // A projection dependency failure is infrastructure, never model feedback: a model told "your Tool
    // result could not be rendered" would treat a host bug as a Tool failure and retry the call.
    throw new Error("Model Tool feedback projection failed.", { cause: error });
  }
  return projected;
}

/**
 * The tool-agnostic fallback budget.
 *
 * It exists so a host that wires no Context projection still gets bounded output rather than unbounded
 * output. It is not a second implementation of the Context algorithm: it knows no Tool names, applies no
 * head + tail treatment, and is only reachable when no projection was injected.
 */
function boundProportionally(
  candidates: readonly ModelObservationCandidate[],
  policy: ToolObservationPolicySnapshot,
): readonly string[] {
  if (policy.maxObservationBatchTokens < candidates.length) {
    // The Context projector refuses this too, and for the same reason: a batch budget smaller than the
    // number of results cannot give every Tool Result a representation. It is unreachable from the
    // default Core policy, which budgets thousands of tokens for a handful of calls.
    throw new RangeError("Observation batch budget cannot preserve every Tool Result");
  }
  const estimator = estimateTokens;
  const weights = candidates.map((candidate) => Math.max(1, estimator(candidate.content)));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  let remainingTokens = policy.maxObservationBatchTokens;
  let remainingWeight = totalWeight;
  return candidates.map((candidate, index) => {
    const weight = weights[index] ?? 1;
    const proportional = Math.floor((remainingTokens * weight) / remainingWeight);
    const allocation = Math.max(
      1,
      Math.min(
        policy.maxSingleObservationTokens,
        proportional,
        remainingTokens - Math.max(0, candidates.length - index - 1),
      ),
    );
    remainingTokens = Math.max(0, remainingTokens - allocation);
    remainingWeight = Math.max(1, remainingWeight - weight);
    return boundText(candidate.content, allocation, estimator);
  });
}

/** Bound one text to a token budget with a marker, cutting on code-point boundaries. */
function boundText(content: string, maxTokens: number, estimator: (text: string) => number): string {
  if (estimator(content) <= maxTokens) return content;
  const marker =
    estimator(MODEL_FEEDBACK_TRUNCATION_MARKER) <= maxTokens
      ? MODEL_FEEDBACK_TRUNCATION_MARKER
      : MINIMAL_TRUNCATION_MARKER;
  const available = Math.max(0, maxTokens - estimator(marker));
  return `${boundedPrefix(content, available, estimator)}${marker}`;
}

/**
 * The longest code-point prefix whose estimate fits the budget.
 *
 * Binary search over a spread array rather than a slice index, so an astral code point is never split
 * into half a surrogate pair — a truncated emoji must not become an invalid UTF-16 sequence in a
 * provider request.
 */
function boundedPrefix(
  content: string,
  maxTokens: number,
  estimator: (text: string) => number,
): string {
  const characters = [...content];
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (estimator(candidate) <= maxTokens) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

/** The UTF-8 byte heuristic the Context estimator uses, restated here as a measurement only. */
function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

/* ------------------------------------------------------------------------------------------------
 * Candidates
 * ---------------------------------------------------------------------------------------------- */

/**
 * The model-view candidate of one batch item.
 *
 * `OBSERVATION` takes the durable observation's own content and error flag. `REJECTED` and `SKIPPED`
 * take only the safe feedback's content. Neither arm can reach a raw execution result, because neither
 * arm was given one.
 */
function candidateOf(item: ToolBatchItemOutcome): ModelObservationCandidate {
  switch (item.kind) {
    case "OBSERVATION":
      return {
        // The durable invocation id is the projection's stable source identity; it is not model-facing.
        sourceToolInvocationId: item.invocationId,
        toolName: item.call.toolName,
        content: item.observation.content,
        ...(item.observation.rawArtifactRef === undefined
          ? {}
          : { rawArtifactRef: item.observation.rawArtifactRef }),
      };
    case "REJECTED":
    case "SKIPPED":
      return {
        // A rejection and a skip have no durable invocation and must never invent one. The external call
        // identity is the honest stable identity available to them.
        sourceToolInvocationId: item.call.externalCallId,
        toolName: item.call.toolName,
        content: item.feedback.content,
      };
  }
}

/**
 * The error flag of one projected message.
 *
 * ```text
 * OBSERVATION   the durable observation's own isError  (COMPLETED false, FAILED true, CANCELLED either)
 * REJECTED      true — the call did not run and the model must correct it
 * SKIPPED       true — the call did not run and the model must not continue the chain
 * ```
 */
function isErrorOf(item: ToolBatchItemOutcome): boolean {
  switch (item.kind) {
    case "OBSERVATION":
      return item.observation.isError;
    case "REJECTED":
    case "SKIPPED":
      return true;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Integrity
 * ---------------------------------------------------------------------------------------------- */

/**
 * Prove that the items answer the calls exactly.
 *
 * ```text
 * missing item    a requested call has no item
 * foreign item    an item answers a call nobody requested
 * duplicate item  two items claim the same call
 * reordered item  an item is not in the call's position
 * ```
 *
 * This is the projector's own defense; the `ToolResultBatchNormalizer` is the second one, applied to the
 * messages this produces. Both fail closed, because a model history that pairs one call with another
 * Tool's output is worse than a failed Run.
 */
function assertItemBatchMatchesCalls(
  calls: readonly ToolCallRequest[],
  items: readonly ToolBatchItemOutcome[],
): void {
  if (items.length !== calls.length) {
    throw new AgentToolResultBatchError("MISSING_RESULT", {
      requestCount: calls.length,
      resultCount: items.length,
    });
  }
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const call = calls[index];
    if (call === undefined) {
      throw new AgentToolResultBatchError("UNEXPECTED_RESULT", {
        toolCallId: item.call.externalCallId,
      });
    }
    if (seen.has(item.call.externalCallId)) {
      throw new AgentToolResultBatchError("DUPLICATE_RESULT", {
        toolCallId: item.call.externalCallId,
      });
    }
    if (item.call.externalCallId !== call.externalCallId) {
      // An item out of position is either a foreign item or a reordered batch. Both are refused: the
      // model's own assistant message names the calls in `calls` order, so a different order would
      // describe a Tool turn the model never requested.
      throw new AgentToolResultBatchError("UNEXPECTED_RESULT", {
        toolCallId: item.call.externalCallId,
        resultCount: items.length,
      });
    }
    if (item.call.toolName !== call.toolName) {
      throw new AgentToolResultBatchError("TOOL_NAME_MISMATCH", {
        toolCallId: call.externalCallId,
        toolName: call.toolName,
      });
    }
    seen.add(item.call.externalCallId);
  }
}

/** Refuse a projection policy that cannot bound anything. */
function assertProjectionPolicy(policy: ToolObservationPolicySnapshot): void {
  if (
    !Number.isSafeInteger(policy.maxSingleObservationTokens) ||
    policy.maxSingleObservationTokens < 1 ||
    !Number.isSafeInteger(policy.maxObservationBatchTokens) ||
    policy.maxObservationBatchTokens < 1
  ) {
    throw new RangeError("Observation policy limits must be positive safe integers");
  }
}
