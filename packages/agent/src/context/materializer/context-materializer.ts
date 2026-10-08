import type { AIMessage, AIToolResultMessage, ModelDescriptor } from "@caelush/ai";

import type { AgentMessageProjectorRegistry } from "../../messages/projection/registry.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ToolObservationPolicySnapshot } from "../../loop/types.js";
import type { PreparedAgentContext } from "../contracts/prepared-agent-context.js";
import type { ContextTokenEstimatorPort } from "../token/context-token-estimator.js";
import type { AgentMessageId } from "../../messages/types/ids.js";
import { completePromptSurfaceAnchors } from "../surface/prompt-surface-anchors.js";
import { projectPromptSurface } from "../surface/prompt-surface-projector.js";
import { PromptSurfaceIntegrityError } from "../surface/prompt-surface.js";
import type { PromptSurfaceAnchor } from "../surface/prompt-surface.js";
import { renderStableContextHead } from "../surface/prompt-surface-renderer.js";

export interface ContextMaterializer {
  materialize(input: {
    readonly prepared: PreparedAgentContext;
    readonly model: ModelDescriptor;
    readonly signal: AbortSignal;
    /** Re-read only the current observation-backed Tool tail under the recovery policy. */
    readonly reprojectOpenToolObservations?: boolean;
  }): Promise<readonly AIMessage[]>;
}

/**
 * Host adapter for the one recovery-only read of raw Tool output.
 *
 * Normal projection remains entirely message-local: the durable `projectedContent` is the historical
 * model-visible truth. A daemon may provide this adapter so forced provider-overflow recovery can
 * reproject an observation-backed tail message under the tighter recovery policy without teaching the
 * Agent package about SQLite or artifact storage.
 */
export interface ContextToolObservationReprojector {
  reproject(input: {
    readonly stored: StoredAgentMessage;
    readonly policy: ToolObservationPolicySnapshot;
    readonly model: ModelDescriptor;
    readonly signal: AbortSignal;
  }): Promise<AIToolResultMessage | undefined>;
}

export interface ContextMaterializerOptions {
  readonly projectors: AgentMessageProjectorRegistry;
  readonly tokenEstimator: ContextTokenEstimatorPort;
  readonly toolObservationReprojector?: ContextToolObservationReprojector;
}

/** Build the one provider-neutral AI message sequence for a prepared Context. */
export function createContextMaterializer(
  options: ContextMaterializerOptions,
): ContextMaterializer {
  return Object.freeze({
    async materialize(input: {
      readonly prepared: PreparedAgentContext;
      readonly model: ModelDescriptor;
      readonly signal: AbortSignal;
      readonly reprojectOpenToolObservations?: boolean;
    }): Promise<readonly AIMessage[]> {
      throwIfAborted(input.signal);
      const documentText = renderStableContextHead(
        input.prepared.document,
        input.prepared.promptSurface?.epoch.formatVersion ?? 3,
      );
      assertEstimate(options.tokenEstimator.estimateText(documentText, input.model), "document");
      throwIfAborted(input.signal);

      const conversation = withRecoveryTailMessageIds(input.prepared.conversationMessages);
      const messages: AIMessage[] = [Object.freeze({ role: "system", content: documentText })];
      const surfaceMessages = projectPromptSurface(input.prepared.promptSurface?.epoch);
      const snapshotsByAnchor = snapshotsByValidAnchor(
        input.prepared.conversationMessages,
        surfaceMessages,
      );
      for (const stored of conversation.messages) {
        throwIfAborted(input.signal);
        await appendProjection(
          messages,
          stored,
          options,
          input.model,
          input.signal,
          input.reprojectOpenToolObservations === true &&
            conversation.tailMessageIds.has(stored.message.id),
          input.prepared,
        );
        for (const surfaceMessage of snapshotsByAnchor.get(stored.message.id) ?? []) {
          throwIfAborted(input.signal);
          assertEstimate(
            options.tokenEstimator.estimateText(surfaceMessage.content, input.model),
            "prompt surface snapshot",
          );
          // Provenance remains Context-owned; the frozen AI contract receives role and content only.
          messages.push(Object.freeze({ role: "user", content: surfaceMessage.content }));
        }
      }
      throwIfAborted(input.signal);
      return Object.freeze(messages);
    },
  });
}

async function appendProjection(
  messages: AIMessage[],
  stored: StoredAgentMessage,
  options: ContextMaterializerOptions,
  model: ModelDescriptor,
  signal: AbortSignal,
  reprojectOpenToolObservations: boolean,
  prepared: PreparedAgentContext,
): Promise<void> {
  if (!stored.message.audience.model) return;
  if (
    reprojectOpenToolObservations &&
    stored.message.type === "TOOL_RESULT" &&
    stored.message.observation.kind === "OBSERVATION" &&
    options.toolObservationReprojector !== undefined
  ) {
    const reprojected = await options.toolObservationReprojector.reproject({
      stored,
      policy: prepared.observationPolicy,
      model,
      signal,
    });
    if (reprojected !== undefined) {
      assertEstimate(options.tokenEstimator.estimateText(reprojected.content, model), "message");
      messages.push(Object.freeze({ ...reprojected }));
      return;
    }
  }
  assertEstimate(options.tokenEstimator.estimateAgentMessage(stored.message, model), "message");
  const projection = options.projectors.project(stored);
  for (const message of projection.messages) messages.push(Object.freeze({ ...message }));
}

function withRecoveryTailMessageIds(messages: readonly StoredAgentMessage[]): {
  readonly messages: readonly StoredAgentMessage[];
  readonly tailMessageIds: ReadonlySet<string>;
} {
  const latest = messages.at(-1)?.message;
  const latestTurnScope =
    latest === undefined ? undefined : messageTurnScope(latest.runId, latest.conversationTurnId);
  const openProtocolMessageIds = openProtocolMessages(messages);
  const tail = messages.filter(
    (stored) =>
      messageTurnScope(stored.message.runId, stored.message.conversationTurnId) ===
        latestTurnScope || openProtocolMessageIds.has(stored.message.id),
  );
  const tailIds = new Set(tail.map((stored) => stored.message.id));
  return Object.freeze({
    // `PreparedAgentContext` already carries the selected messages in Snapshot order.
    // Run-local sequence restarts at each ConversationTurn, so this layer must not sort it.
    messages,
    tailMessageIds: tailIds,
  });
}

type ProjectedSurfaceMessage = ReturnType<typeof projectPromptSurface>[number];

function snapshotsByValidAnchor(
  messages: readonly StoredAgentMessage[],
  snapshots: readonly ProjectedSurfaceMessage[],
): ReadonlyMap<AgentMessageId, readonly ProjectedSurfaceMessage[]> {
  if (snapshots.length === 0) return new Map();
  const visible = messages.filter((stored) => stored.message.audience.model);
  const boundaries = completePromptSurfaceAnchors(visible);
  const positions = new Map<AgentMessageId, number>();
  visible.forEach((stored, index) => positions.set(stored.message.id, index));
  const result = new Map<AgentMessageId, ProjectedSurfaceMessage[]>();
  let previousPosition = -1;
  for (const snapshot of snapshots) {
    const anchor = snapshot.source.anchor;
    const boundary = boundaries.get(anchor.messageId);
    const position = positions.get(anchor.messageId);
    if (
      boundary === undefined ||
      position === undefined ||
      position < previousPosition ||
      !sameAnchor(boundary, anchor)
    ) {
      throw new PromptSurfaceIntegrityError(
        "Prompt Surface anchor is missing, out of order, or splits a Tool result batch.",
      );
    }
    previousPosition = position;
    const anchored = result.get(anchor.messageId) ?? [];
    anchored.push(snapshot);
    result.set(anchor.messageId, anchored);
  }
  return result;
}

function openProtocolMessages(messages: readonly StoredAgentMessage[]): ReadonlySet<string> {
  const messagesByTurn = new Map<string, StoredAgentMessage[]>();
  for (const stored of messages) {
    if (!stored.message.audience.model) continue;
    const scope = messageTurnScope(stored.message.runId, stored.message.conversationTurnId);
    const turnMessages = messagesByTurn.get(scope) ?? [];
    turnMessages.push(stored);
    messagesByTurn.set(scope, turnMessages);
  }

  const openMessageIds = new Set<string>();
  for (const turnMessages of messagesByTurn.values()) {
    const toolResults = new Set<string>();
    for (const stored of turnMessages) {
      if (stored.message.type === "TOOL_RESULT") toolResults.add(stored.message.toolCallId);
    }
    const openCallIds = new Set<string>();
    for (const stored of turnMessages) {
      if (stored.message.type !== "ASSISTANT") continue;
      const calls = stored.message.content.filter((part) => part.type === "TOOL_CALL");
      const missing = calls.filter((call) => !toolResults.has(call.toolCallId));
      if (missing.length === 0) continue;
      openMessageIds.add(stored.message.id);
      for (const call of calls) openCallIds.add(call.toolCallId);
    }
    for (const stored of turnMessages) {
      if (stored.message.type === "TOOL_RESULT" && openCallIds.has(stored.message.toolCallId)) {
        openMessageIds.add(stored.message.id);
      }
    }
  }
  return openMessageIds;
}

function sameAnchor(left: PromptSurfaceAnchor, right: PromptSurfaceAnchor): boolean {
  return (
    left.messageId === right.messageId &&
    left.runId === right.runId &&
    left.conversationTurnId === right.conversationTurnId &&
    left.sequence === right.sequence
  );
}

function messageTurnScope(runId: string, conversationTurnId: string): string {
  return JSON.stringify([runId, conversationTurnId]);
}

function assertEstimate(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Context materializer ${label} token estimate is invalid.`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("Context materialization was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}
