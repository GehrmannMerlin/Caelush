import type {
  AgentToolResult,
  ModelObservationBatchProjector,
  ModelObservationCandidate,
  ToolExecutionSnapshot,
} from "@caelush/agent";
import { LLMToolResultMessageSchema, type LLMToolResultMessage } from "@caelush/llm/messages";
import type { AgentToolRequest } from "./agent-decision.js";
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
 * Project one settled Tool batch onto the frozen model-facing Tool results.
 *
 * ```text
 * ToolExecutionSnapshot   the durable invocation + its observation
 *        ↓
 * Context token projection (the one truncation policy the workspace owns)
 *        ↓
 * AgentToolResult         externalCallId, toolName, summary content, isError
 * ```
 *
 * This is a **compatibility** projection for a caller that still holds durable snapshots. Canonical
 * production does not call it: the canonical `ModelToolFeedbackProjector` projects durable observations
 * and safe feedback, and the Run Layer reaches it through `packages/core/src/run-tool-turn-coordinator.ts`.
 * It is retained for legacy callers and their tests, and it is the same Context algorithm either way —
 * there is one truncation policy, not two.
 *
 * Phase 4F replaced the legacy `ToolBatchItemResult` input with the canonical `ToolExecutionSnapshot`.
 * The projection itself did not change: an invocation's observation carries exactly the content, the
 * error flag and the raw artifact pointer the legacy per-item result carried, and the durable identity
 * is the same invocation id. A snapshot with no observation has not settled, and is refused here rather
 * than projected as empty content.
 */
export function toAgentToolResults(
  requests: readonly AgentToolRequest[],
  snapshots: readonly ToolExecutionSnapshot[],
  policy: AgentToolObservationPolicy = defaultObservationPolicy(),
): readonly AgentToolResult[] {
  return toLLMToolResultMessages(requests, snapshots, policy).map((message) => ({
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
  snapshots: readonly ToolExecutionSnapshot[],
  policy: AgentToolObservationPolicy = defaultObservationPolicy(),
): readonly LLMToolResultMessage[] {
  if (requests.length !== snapshots.length) throw new ToolBatchResultConversionError();
  const candidates: ModelObservationCandidate[] = requests.map((request, index) => {
    const observation = observationOf(snapshots[index], request);
    return {
      sourceToolInvocationId: observation.toolInvocationId,
      toolName: request.toolName,
      content: observation.content,
      ...(observation.rawArtifactRef === undefined
        ? {}
        : { rawArtifactRef: observation.rawArtifactRef }),
    };
  });
  const summaries = toContextObservationProjection().projectBatch({ candidates, policy });
  return requests.map((request, index) => {
    const snapshot = snapshots[index];
    const summary = summaries[index];
    if (snapshot === undefined || summary === undefined) {
      throw new ToolBatchResultConversionError();
    }
    const observation = observationOf(snapshot, request);
    const message = {
      role: "tool" as const,
      toolCallId: request.externalCallId,
      toolName: request.toolName,
      content: summary,
      isError: observation.isError,
      ...(observation.rawArtifactRef === undefined
        ? {}
        : { rawArtifactRef: observation.rawArtifactRef }),
    };
    return LLMToolResultMessageSchema.parse(message);
  });
}

/**
 * The durable observation of one request's snapshot.
 *
 * The identity is checked rather than assumed: a snapshot whose invocation is a different Tool or a
 * different model call is a batch-conversion defect, not a Tool error, so it is refused instead of
 * being projected onto the wrong request.
 */
function observationOf(
  snapshot: ToolExecutionSnapshot | undefined,
  request: AgentToolRequest,
): import("@caelush/protocol").ToolObservation {
  if (snapshot === undefined) throw new ToolBatchResultConversionError();
  if (snapshot.invocation.toolName !== request.toolName) {
    throw new ToolBatchResultConversionError();
  }
  if (
    snapshot.invocation.externalCallId !== undefined &&
    snapshot.invocation.externalCallId !== request.externalCallId
  ) {
    throw new ToolBatchResultConversionError();
  }
  const observation = snapshot.observation;
  if (observation === undefined) throw new ToolBatchResultConversionError();
  return observation;
}
