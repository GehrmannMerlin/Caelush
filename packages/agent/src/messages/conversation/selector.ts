import type { AIConversationMessage } from "@caelush/ai";

import type { AgentConversationSnapshot } from "./conversation-snapshot.js";
import type { ConversationTurn } from "./conversation-turn.js";
import type { AgentMessage } from "../types/agent-message.js";
import type { AgentMessageId } from "../types/ids.js";
import type { AgentMessageProjectorRegistry } from "../projection/registry.js";
import type { StoredAgentMessage } from "../persistence/record.js";
import { buildConversationExecutionUnits } from "./execution-unit.js";
import type { ExecutionUnit } from "./execution-unit.js";
import type { TokenEstimator } from "./token-estimator.js";

/**
 * What a conversation looks like after the model's budget was applied.
 *
 * ```text
 * turns                  the selected turns, in order
 * selectedMessageIds     what stayed
 * droppedMessageIds      what was left out
 * estimatedTokens        what the selection costs the model
 * requiresCompaction     whether the protected material still does not fit
 * ```
 *
 * ## Both id lists are complete and stable
 *
 * Every message of the input appears in exactly one of the two lists, and both are ordered by
 * the conversation's own order so two selections can be compared structurally. A message the
 * model never sees appears in `selectedMessageIds` — it is retained, not dropped, because
 * dropping it would free no budget — and contributes nothing to `estimatedTokens`, because it
 * is never projected.
 *
 * ## `requiresCompaction` is a report, not a decision
 *
 * It says "the material that may not be dropped still does not fit". What to do about that is
 * the Context Engine's decision in Phase 5D. Phase 5A implements a *safe primitive*, and a
 * primitive that silently summarized history would be a compaction algorithm wearing a
 * selection algorithm's name.
 */
export interface SelectedAgentConversation {
  readonly turns: readonly ConversationTurn[];

  readonly selectedMessageIds: readonly AgentMessageId[];

  readonly droppedMessageIds: readonly AgentMessageId[];

  readonly estimatedTokens: number;

  readonly requiresCompaction: boolean;
}

/**
 * The conversation-level selection primitive.
 *
 * ## The frozen input has no projector registry, and the selector needs one
 *
 * A *projection* is what gets measured, so the selector must be able to project. The frozen
 * `select()` input cannot carry a registry — it is a frozen public contract and this round
 * changes none — so the registry is **injected when the selector is created**:
 *
 * ```text
 * createConversationSelector({ projector })
 *   → ConversationSelector whose select() keeps the frozen signature
 * ```
 *
 * That is an implementation detail in the honest sense: it changes how the object is built,
 * not what the interface promises.
 *
 * ## Selection measures the projection, never the message
 *
 * ```text
 * StoredAgentMessage → projector → AIConversationMessage[] → TokenEstimator → a number
 * ```
 *
 * Nothing here serializes an `AgentMessage` and measures that. A durable message carries an
 * id, a Run, a session, a turn, a source, an audience, a schema version and an observation
 * pointer; none of it reaches the model, and counting it would systematically over-estimate
 * the cost and drop history that actually fits.
 *
 * ## Safety: the Tool protocol is atomic and the tail is protected
 *
 * ```text
 * a Tool call is never selected without its results, or the reverse
 * an OPEN execution unit is never dropped
 * ```
 *
 * Selection therefore operates on *groups*: the messages of one execution unit are kept or
 * dropped together. A per-message loop could drop the tail of a Tool batch and leave the
 * model with a call it cannot answer — the provider would reject the request, and the Run
 * would fail for a budgeting reason that had nothing to do with the budget.
 *
 * An open unit is the turn the Agent is *in the middle of*: the model announced calls and the
 * answers are still coming. Dropping it would not merely lose history, it would lose the work.
 * So an open unit is protected, and if the protected material cannot fit, the answer is
 * `requiresCompaction` rather than a smaller context.
 *
 * The protected tail is everything from the newest model-visible user message onward. A
 * conversation with no recent user message has no protected tail, which is correct: there is
 * nothing the model has been asked that it must still see.
 */
export interface ConversationSelector {
  select(input: {
    readonly conversation: AgentConversationSnapshot;

    readonly maxTokens: number;

    readonly estimator: TokenEstimator;
  }): SelectedAgentConversation;
}

export interface ConversationSelectorOptions {
  /** The projector registry. Required: selection measures projections. */
  readonly projector: AgentMessageProjectorRegistry;
}

/**
 * Build the canonical selector.
 *
 * Stateless apart from the injected registry, so the same snapshot and the same budget always
 * produce the same selection.
 */
export function createConversationSelector(
  options: ConversationSelectorOptions,
): ConversationSelector {
  const { projector } = options;

  return {
    select(input: {
      readonly conversation: AgentConversationSnapshot;
      readonly maxTokens: number;
      readonly estimator: TokenEstimator;
    }): SelectedAgentConversation {
      const { conversation, maxTokens, estimator } = input;
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
        throw new RangeError(
          "Conversation selection maxTokens must be a non-negative safe integer.",
        );
      }

      const allMessages = conversation.turns.flatMap((turn) => [...turn.messages]);
      const visible = allMessages.filter((stored) => stored.message.audience.model);
      const units = buildConversationExecutionUnits(conversation.turns, estimator, projector);

      const protectedIds = protectedMessageIds(allMessages, visible, units);
      const groups = droppableGroups(visible, units, protectedIds);

      const dropped = new Set<string>();
      let tokens = measure(visible, projector, estimator);
      for (const group of groups) {
        if (tokens <= maxTokens) break;
        for (const id of group) dropped.add(id);
        tokens = measure(
          visible.filter((stored) => !dropped.has(stored.message.id)),
          projector,
          estimator,
        );
      }

      const survivingProtected = visible.filter(
        (stored) => protectedIds.has(stored.message.id) && !dropped.has(stored.message.id),
      );
      const requiresCompaction =
        survivingProtected.length > 0 &&
        measure(survivingProtected, projector, estimator) > maxTokens;

      const selectedIds: AgentMessageId[] = [];
      const droppedIds: AgentMessageId[] = [];
      for (const stored of allMessages) {
        const id = stored.message.id;
        if (!stored.message.audience.model) {
          // Not model-visible: retained, and never a drop candidate. Dropping it would free no
          // budget and would lose a message the transcript or a debug view may need.
          selectedIds.push(id);
          continue;
        }
        if (dropped.has(id)) droppedIds.push(id);
        else selectedIds.push(id);
      }

      const selectedIdSet = new Set<string>(selectedIds);
      const turns = conversation.turns
        .map((turn) => {
          const messages = turn.messages.filter((stored) => selectedIdSet.has(stored.message.id));
          return messages.length === turn.messages.length
            ? turn
            : Object.freeze({ ...turn, messages: Object.freeze(messages) });
        })
        .filter((turn) => turn.messages.length > 0);

      return Object.freeze({
        turns: Object.freeze(turns),
        selectedMessageIds: Object.freeze(selectedIds),
        droppedMessageIds: Object.freeze(droppedIds),
        estimatedTokens: tokens,
        requiresCompaction,
      });
    },
  };
}

/* ------------------------------------------------------------------------------- internals */

/**
 * The messages selection may not drop.
 *
 * ```text
 * everything from the newest model-visible user message onward      the current ask
 * every message of an OPEN execution unit                          work in flight
 * the whole unit when any of its messages is protected             atomicity
 * ```
 *
 * The third rule is what makes the second and first compose. A unit whose answer happened to
 * land after a protected user message would otherwise be half-protected, and "drop half a Tool
 * exchange" is the one outcome the atomicity rule exists to prevent.
 */
function protectedMessageIds(
  allMessages: readonly StoredAgentMessage[],
  visible: readonly StoredAgentMessage[],
  units: readonly ExecutionUnit[],
): ReadonlySet<string> {
  const protectedIds = new Set<string>();

  const lastUserIndex = lastModelVisibleUserIndex(visible);
  if (lastUserIndex !== undefined) {
    for (const stored of visible.slice(lastUserIndex)) protectedIds.add(stored.message.id);
  }

  for (const unit of units) {
    const members = unitMembers(allMessages, unit);
    const unitProtected =
      unit.status === "OPEN" || members.some((stored) => protectedIds.has(stored.message.id));
    if (!unitProtected) continue;
    for (const stored of members) protectedIds.add(stored.message.id);
  }

  return protectedIds;
}

/**
 * The messages one execution unit covers, resolved by sequence range within its own Run.
 *
 * The range is inclusive at both ends and is bounded to the unit's Run, so a Session with
 * several Runs cannot have one Run's range capture another's messages.
 */
function unitMembers(
  allMessages: readonly StoredAgentMessage[],
  unit: ExecutionUnit,
): readonly StoredAgentMessage[] {
  return allMessages.filter(
    (stored) =>
      stored.message.runId === unit.runId &&
      stored.sequence >= unit.sourceSequenceFrom &&
      stored.sequence <= unit.sourceSequenceTo,
  );
}

/**
 * Partition the droppable model-visible messages into atomic groups, oldest group first.
 *
 * One group per closed execution unit; one group per message otherwise. Groups never mix
 * messages from two units, which is what makes "drop a group" equivalent to "drop a whole Tool
 * exchange" rather than "drop whatever was next".
 */
function droppableGroups(
  visible: readonly StoredAgentMessage[],
  units: readonly ExecutionUnit[],
  protectedIds: ReadonlySet<string>,
): readonly (readonly string[])[] {
  const unitByMessageId = new Map<string, ExecutionUnit>();
  for (const unit of units) {
    // Identity, not position: a unit names its own messages, so a compaction or a re-import
    // that reordered the ledger cannot attach a unit to the wrong messages.
    unitByMessageId.set(unit.assistantMessageId, unit);
    for (const id of unit.toolResultMessageIds) unitByMessageId.set(id, unit);
  }

  const groups: (readonly string[])[] = [];
  const emitted = new Set<string>();
  for (const stored of visible) {
    const id = stored.message.id;
    if (protectedIds.has(id)) continue;
    const unit = unitByMessageId.get(id);
    if (unit === undefined) {
      groups.push([id]);
      continue;
    }
    if (unit.status === "OPEN" || emitted.has(unit.id)) continue;
    emitted.add(unit.id);
    const memberIds: string[] = [];
    for (const candidate of visible) {
      const candidateUnit = unitByMessageId.get(candidate.message.id);
      if (candidateUnit?.id !== unit.id) continue;
      // A unit is dropped whole or not at all; a protected member protects the unit.
      if (protectedIds.has(candidate.message.id)) {
        memberIds.length = 0;
        break;
      }
      memberIds.push(candidate.message.id);
    }
    if (memberIds.length > 0) groups.push(memberIds);
  }
  return groups;
}

/** The index of the newest model-visible user message, or `undefined` when there is none. */
function lastModelVisibleUserIndex(visible: readonly StoredAgentMessage[]): number | undefined {
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const message: AgentMessage | undefined = visible[index]?.message;
    if (message?.type === "USER") return index;
  }
  return undefined;
}

/** What the model would be charged for a set of stored messages. */
function measure(
  messages: readonly StoredAgentMessage[],
  projector: AgentMessageProjectorRegistry,
  estimator: TokenEstimator,
): number {
  const projected: AIConversationMessage[] = [];
  for (const stored of messages) {
    projected.push(...projector.project(stored).messages);
  }
  return estimator.estimateMessages(projected);
}
