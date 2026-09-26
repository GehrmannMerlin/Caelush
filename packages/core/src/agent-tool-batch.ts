import type {
  AgentToolResult,
  ModelObservationBatchProjector,
  ModelObservationCandidate,
  ToolExecutionSnapshot,
} from "@caelush/agent";
import { createToolObservationBatchProjector } from "@caelush/agent";
import type { AIToolResultMessage } from "@caelush/ai";
import type { AgentToolRequest } from "./agent-decision.js";
import { ToolBatchResultConversionError } from "./agent-errors.js";

export interface AgentToolObservationPolicy {
  readonly maxSingleObservationTokens: number;
  readonly maxObservationBatchTokens: number;
}

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
 * The Agent-owned observation token projection, as the canonical projector's implementation seam.
 *
 * ```text
 * @caelush/agent      owns model feedback semantics and the bounded projection
 * @caelush/core       adapts the canonical projector to legacy Core message helpers
 * ```
 *
 * This is a **compatibility adapter**, not a second authority. The canonical Agent projector decides
 * how much of a safe observation fits; Core only converts durable snapshots into the Agent contract.
 */
export function toContextObservationProjection(): ModelObservationBatchProjector {
  return createToolObservationBatchProjector();
}

/**
 * Project one settled Tool batch onto the frozen model-facing Tool results.
 *
 * ```text
 * ToolExecutionSnapshot   the durable invocation + its observation
 *        ↓
 * Agent Tool observation projection (the one truncation policy the workspace owns)
 *        ↓
 * AgentToolResult         externalCallId, toolName, summary content, isError
 * ```
 *
 * This is a **compatibility** projection for a caller that still holds durable snapshots. Canonical
 * production does not call it: the canonical `ModelToolFeedbackProjector` projects durable observations
 * and safe feedback, and the Run Layer reaches it through `packages/core/src/run-tool-turn-coordinator.ts`.
 * It is retained for compatibility callers and their tests, and it uses the same Agent observation
 * algorithm as the canonical feedback path — there is one truncation policy, not two.
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
  return toAIToolResultMessages(requests, snapshots, policy).map((message) => ({
    externalCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    isError: message.isError,
  }));
}

/**
 * The legacy durable message encoding of one Tool batch.
 *
 * Kept because the durable conversation compatibility ledger still speaks `LLMToolResultMessage`,
 * including its `rawArtifactRef` recovery pointer. The pointer never enters the canonical
 * `AIToolResultMessage`; durable Tool recovery remains the authority for it.
 */
export function toAIToolResultMessages(
  requests: readonly AgentToolRequest[],
  snapshots: readonly ToolExecutionSnapshot[],
  policy: AgentToolObservationPolicy = defaultObservationPolicy(),
): readonly AIToolResultMessage[] {
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
    const message: AIToolResultMessage = {
      role: "tool" as const,
      toolCallId: request.externalCallId,
      toolName: request.toolName,
      content: summary,
      isError: observation.isError,
    };
    return message;
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
