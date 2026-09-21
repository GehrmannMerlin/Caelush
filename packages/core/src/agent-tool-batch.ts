import type {
  AgentToolResult,
  ModelObservationBatchProjector,
  ModelObservationCandidate,
} from "@caelush/agent";
import { LLMToolResultMessageSchema, type LLMToolResultMessage } from "@caelush/llm/messages";
import type { AgentToolRequest } from "./agent-decision.js";
import type { ToolBatchItemResult } from "@caelush/tools";
import { ToolBatchResultConversionError } from "./agent-errors.js";
import {
  projectToolObservationBatch,
  Utf8HeuristicTokenEstimator,
  type ContextPolicy,
} from "@caelush/context";

const modelObservationEstimator = new Utf8HeuristicTokenEstimator();

export type AgentToolObservationPolicy = Pick<
  ContextPolicy,
  "maxSingleObservationTokens" | "maxObservationBatchTokens"
>;

const LEGACY_EFFECTIVE_INPUT_LIMIT = 32_000;

/**
 * The compatibility observation policy of a host that configured no Context policy.
 *
 * It is the legacy Core's own long-standing default — the same ratios the Context runtime's
 * policy factory derives from a real effective input limit — and it is exported so the two
 * Core boundaries that need it (the Tool result projection and the Context compatibility
 * adapter) cannot drift into two different defaults.
 */
export function defaultObservationPolicy(): AgentToolObservationPolicy {
  return {
    maxSingleObservationTokens: Math.max(1, Math.floor(LEGACY_EFFECTIVE_INPUT_LIMIT * 0.1)),
    maxObservationBatchTokens: Math.max(1, Math.floor(LEGACY_EFFECTIVE_INPUT_LIMIT * 0.22)),
  };
}

/**
 * The Context-owned observation token projection, as the canonical projector's implementation seam.
 *
 * ```text
 * @caelush/agent      owns model feedback semantics        (ModelToolFeedbackProjector)
 * @caelush/context    owns the token projection algorithm  (projectToolObservationBatch)
 * @caelush/core       adapts the two, here
 * ```
 *
 * This is a **compatibility adapter**, not an authority. The canonical projector decides *what* the
 * model is told; this function decides only *how much of it fits*. It is wired in at the composition
 * boundary because Architecture V2 forbids `@caelush/agent` from importing `@caelush/context`, and the
 * agent package must not copy the algorithm either — a copy would be a second observation-budget
 * algorithm, and it would silently lose the head + omission-marker + tail treatment the Context
 * projector applies to large `read_file` and `exec_command` output.
 */
export function toContextObservationProjection(): ModelObservationBatchProjector {
  return {
    projectBatch(input: {
      readonly candidates: readonly ModelObservationCandidate[];
      readonly policy: AgentToolObservationPolicy;
    }): readonly string[] {
      return projectToolObservationBatch({
        observations: input.candidates.map((candidate) => ({
          // The durable invocation id is the projection's stable source identity; it is never
          // model-facing, and a `REJECTED`/`SKIPPED` call falls back to its external call id because it
          // has no durable invocation to name.
          sourceToolInvocationId: candidate.sourceToolInvocationId,
          toolName: candidate.toolName,
          content: candidate.content,
          ...(candidate.rawArtifactRef === undefined
            ? {}
            : { rawArtifactRef: candidate.rawArtifactRef }),
        })),
        maxSingleObservationTokens: input.policy.maxSingleObservationTokens,
        maxObservationBatchTokens: input.policy.maxObservationBatchTokens,
        estimator: modelObservationEstimator,
      }).map((observation) => observation.summary);
    },
  };
}

/**
 * Project one legacy Tool batch onto the frozen model-facing Tool results.
 *
 * ```text
 * ToolBatchItemResult   raw output, invocation id, observation id, artifact pointer
 *        ↓
 * Context token projection (the one truncation policy the workspace owns)
 *        ↓
 * AgentToolResult       externalCallId, toolName, summary content, isError
 * ```
 *
 * This is the **legacy compatibility** projection. Canonical production no longer calls it: the
 * canonical `ModelToolFeedbackProjector` projects durable observations and safe feedback, and the Run
 * Layer reaches it through `packages/core/src/run-tool-turn-coordinator.ts`. It is retained for legacy
 * callers and their tests, and it is the same Context algorithm either way — there is one truncation
 * policy, not two.
 */
export function toAgentToolResults(
  requests: readonly AgentToolRequest[],
  results: readonly ToolBatchItemResult[],
  policy: AgentToolObservationPolicy = defaultObservationPolicy(),
): readonly AgentToolResult[] {
  return toLLMToolResultMessages(requests, results, policy).map((message) => ({
    externalCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    isError: message.isError,
  }));
}

/**
 * The legacy durable message encoding of one Tool batch.
 *
 * Kept because the durable conversation ledger and the legacy Context runtime still speak
 * `LLMToolResultMessage`, including its `rawArtifactRef` recovery pointer. The pointer never enters the
 * canonical `AIToolResultMessage`; the Context adapter re-attaches it from the durable ledger, which is
 * the authority for it.
 */
export function toLLMToolResultMessages(
  requests: readonly AgentToolRequest[],
  results: readonly ToolBatchItemResult[],
  policy: AgentToolObservationPolicy = defaultObservationPolicy(),
): readonly LLMToolResultMessage[] {
  if (requests.length !== results.length) throw new ToolBatchResultConversionError();
  const candidates: ModelObservationCandidate[] = requests.map((request, index) => {
    const result = results[index];
    if (
      result === undefined ||
      result.externalCallId !== request.externalCallId ||
      result.toolName !== request.toolName
    ) {
      throw new ToolBatchResultConversionError();
    }
    return {
      sourceToolInvocationId: result.invocationId ?? result.externalCallId,
      toolName: result.toolName,
      content: result.content,
      ...(result.rawArtifactRef === undefined ? {} : { rawArtifactRef: result.rawArtifactRef }),
    };
  });
  const summaries = toContextObservationProjection().projectBatch({ candidates, policy });
  return requests.map((request, index) => {
    const result = results[index];
    const summary = summaries[index];
    if (result === undefined || summary === undefined) throw new ToolBatchResultConversionError();
    const message = {
      role: "tool" as const,
      toolCallId: result.externalCallId,
      toolName: result.toolName,
      content: summary,
      isError: result.isError,
      ...(result.rawArtifactRef === undefined ? {} : { rawArtifactRef: result.rawArtifactRef }),
    };
    return LLMToolResultMessageSchema.parse(message);
  });
}
