import type { AgentConversationSnapshot } from "./conversation-snapshot.js";
import type { ConversationTurn } from "./conversation-turn.js";
import type { AgentMessage } from "../types/agent-message.js";

/**
 * The target Message V2 conversation authority.
 *
 * ```text
 * AgentConversationValidator   the NEW authority — this file
 * AI history validator         the OLD one — loop/history/conversation-history.ts
 * ```
 *
 * ## Two validators exist during Phase 5A, and only one of them is the target
 *
 * ```text
 * assertConversationProtocolIntegrity   validates AIMessage history, is called by the
 *                                       production AgentLoop today, and is NOT extended
 * AgentConversationValidator            validates AgentMessage snapshots, is called by
 *                                       nothing in production yet, and is where new rules go
 * ```
 *
 * The old validator stays because removing it would break the production loop that still
 * speaks `AIMessage`; that cutover is Phase 5C and 5D. It must not *grow*: a rule added
 * there would live in the compatibility layer and never reach the target. The two are not
 * two authorities over one question — the old one answers the question for the language
 * production currently uses, and it retires with that language.
 *
 * ## There is no such thing as a partial validation
 *
 * `validate()` returns `void` and throws on the first violation. A validator that returned
 * a list of problems would let a caller proceed with the ones it did not read, and the
 * consequences of proceeding are the reason the checks exist: a Tool call the model is
 * shown without its result, or a message that claims a Run it does not belong to.
 */
export interface AgentConversationValidator {
  validate(snapshot: AgentConversationSnapshot): void;
}

/**
 * Why a conversation is not valid.
 *
 * Closed on purpose, so a caller can switch on it, and *specific* on purpose, so a
 * diagnostic names the rule rather than quoting the conversation.
 */
export type AgentConversationViolationReason =
  | "EMPTY_SESSION_ID"
  | "DUPLICATE_MESSAGE_ID"
  | "DUPLICATE_TURN_ID"
  | "TURN_RUN_MISMATCH"
  | "TURN_SESSION_MISMATCH"
  | "TURN_ORDER_INVALID"
  | "MESSAGE_RUN_MISMATCH"
  | "MESSAGE_SESSION_MISMATCH"
  | "MESSAGE_TURN_MISMATCH"
  | "MESSAGE_SEQUENCE_NOT_INCREASING"
  | "CURRENT_RUN_MISSING"
  | "CURRENT_TURN_MISMATCH"
  | "DUPLICATE_TOOL_CALL_ID"
  | "DUPLICATE_TOOL_RESULT"
  | "ORPHAN_TOOL_RESULT"
  | "MISSING_TOOL_RESULT"
  | "TOOL_RESULT_NAME_MISMATCH"
  | "MODEL_VISIBLE_RESULT_REQUIRED";

/** Every violation reason, in canonical order. */
export const AGENT_CONVERSATION_VIOLATION_REASONS = [
  "EMPTY_SESSION_ID",
  "DUPLICATE_MESSAGE_ID",
  "DUPLICATE_TURN_ID",
  "TURN_RUN_MISMATCH",
  "TURN_SESSION_MISMATCH",
  "TURN_ORDER_INVALID",
  "MESSAGE_RUN_MISMATCH",
  "MESSAGE_SESSION_MISMATCH",
  "MESSAGE_TURN_MISMATCH",
  "MESSAGE_SEQUENCE_NOT_INCREASING",
  "CURRENT_RUN_MISSING",
  "CURRENT_TURN_MISMATCH",
  "DUPLICATE_TOOL_CALL_ID",
  "DUPLICATE_TOOL_RESULT",
  "ORPHAN_TOOL_RESULT",
  "MISSING_TOOL_RESULT",
  "TOOL_RESULT_NAME_MISMATCH",
  "MODEL_VISIBLE_RESULT_REQUIRED",
] as const satisfies readonly AgentConversationViolationReason[];

/**
 * The refusal.
 *
 * It carries the closed reason, the turn id and the message id when one is identifiable —
 * all of which are identities the caller already holds — and never a message's content. A
 * conversation that fails validation is reported; it is not quoted back, because the
 * payload may be a Tool's output, a file's contents or the user's own text.
 */
export class AgentConversationError extends Error {
  readonly reason: AgentConversationViolationReason;
  readonly turnId?: string;
  readonly messageId?: string;

  constructor(
    reason: AgentConversationViolationReason,
    location: { readonly turnId?: string; readonly messageId?: string } = {},
  ) {
    super(agentConversationErrorMessage(reason));
    this.name = "AgentConversationError";
    this.reason = reason;
    if (location.turnId !== undefined) this.turnId = location.turnId;
    if (location.messageId !== undefined) this.messageId = location.messageId;
  }
}

/** The fixed, safe summary of one violation. */
export function agentConversationErrorMessage(reason: AgentConversationViolationReason): string {
  switch (reason) {
    case "EMPTY_SESSION_ID":
      return "A conversation snapshot must name a session.";
    case "DUPLICATE_MESSAGE_ID":
      return "The conversation contains the same agent message id twice.";
    case "DUPLICATE_TURN_ID":
      return "The conversation contains the same conversation turn id twice.";
    case "TURN_RUN_MISMATCH":
      return "A conversation turn is owned by more than one Run.";
    case "TURN_SESSION_MISMATCH":
      return "A conversation turn names a session other than the snapshot's.";
    case "TURN_ORDER_INVALID":
      return "Conversation turns are not ordered by opening time and identity.";
    case "MESSAGE_RUN_MISMATCH":
      return "A message names a Run other than its turn's.";
    case "MESSAGE_SESSION_MISMATCH":
      return "A message names a session other than its turn's.";
    case "MESSAGE_TURN_MISMATCH":
      return "A message names a conversation turn other than the one it is stored in.";
    case "MESSAGE_SEQUENCE_NOT_INCREASING":
      return "Message sequences within a turn are not strictly increasing.";
    case "CURRENT_RUN_MISSING":
      return "The snapshot's current Run has no turn.";
    case "CURRENT_TURN_MISMATCH":
      return "The snapshot's current turn does not belong to its current Run.";
    case "DUPLICATE_TOOL_CALL_ID":
      return "An assistant message announces the same tool call id twice, or a turn reuses one.";
    case "DUPLICATE_TOOL_RESULT":
      return "The conversation answers the same tool call more than once.";
    case "ORPHAN_TOOL_RESULT":
      return "A tool result answers a tool call this conversation never announced.";
    case "MISSING_TOOL_RESULT":
      return "A tool call has no matching tool result in its turn.";
    case "TOOL_RESULT_NAME_MISMATCH":
      return "A tool result names a different tool than the call it answers.";
    case "MODEL_VISIBLE_RESULT_REQUIRED":
      return "A model-visible tool call must be answered by a model-visible tool result.";
  }
}

/**
 * The canonical conversation validator.
 *
 * ## Durable structure versus model-visible structure
 *
 * The two questions are asked separately, and keeping them separate is what stops a
 * hidden message from manufacturing a fake orphan:
 *
 * ```text
 * durable structure          every message in every turn: identity, scope, ordering
 * model-visible structure    only messages with audience.model = true: the Tool protocol
 * ```
 *
 * A UI-only or debug-only message is a real message and must satisfy the durable rules. It
 * must not, however, participate in the Tool-call ledger — because the model never saw it,
 * so it can neither answer a call nor leave one unanswered. A validator that walked all
 * messages would report an orphaned result for a hidden transcript annotation and refuse a
 * perfectly legal conversation.
 *
 * The one rule that crosses the boundary is deliberate and runs the other way: a
 * **model-visible** tool call must be answered by a **model-visible** tool result. If the
 * model saw the call and the answer is hidden, the provider would receive a request whose
 * Tool protocol is incomplete, so that combination is refused in the model-visible pass.
 *
 * ## What it does not check
 *
 * ```text
 * content shape            each message was validated when it was decoded
 * token budget             the ConversationSelector's question
 * Run status               the Run Layer's authority, never restated here
 * ```
 */
export function createAgentConversationValidator(): AgentConversationValidator {
  return {
    validate(snapshot: AgentConversationSnapshot): void {
      if (typeof snapshot.sessionId !== "string" || snapshot.sessionId.length === 0) {
        throw new AgentConversationError("EMPTY_SESSION_ID");
      }

      const messageIds = new Set<string>();
      const turnIds = new Set<string>();
      const turnRunIds = new Map<string, string>();
      const turnById = new Map<string, ConversationTurn>();
      let previousOrder: readonly [number, string] | undefined;

      for (const turn of snapshot.turns) {
        /* ---- durable turn structure ---- */
        if (turnIds.has(turn.id)) {
          throw new AgentConversationError("DUPLICATE_TURN_ID", { turnId: turn.id });
        }
        turnIds.add(turn.id);
        turnById.set(turn.id, turn);

        const existingRun = turnRunIds.get(turn.id);
        if (existingRun !== undefined && existingRun !== turn.runId) {
          throw new AgentConversationError("TURN_RUN_MISMATCH", { turnId: turn.id });
        }
        turnRunIds.set(turn.id, turn.runId);

        if (turn.sessionId !== snapshot.sessionId) {
          throw new AgentConversationError("TURN_SESSION_MISMATCH", { turnId: turn.id });
        }

        const order: readonly [number, string] = [turn.openedAt, turn.id];
        if (
          previousOrder !== undefined &&
          (order[0] < previousOrder[0] ||
            (order[0] === previousOrder[0] && order[1] <= previousOrder[1]))
        ) {
          throw new AgentConversationError("TURN_ORDER_INVALID", { turnId: turn.id });
        }
        previousOrder = order;

        /* ---- durable message structure ---- */
        let previousSequence: number | undefined;
        for (const stored of turn.messages) {
          const message: AgentMessage = stored.message;

          if (messageIds.has(message.id)) {
            throw new AgentConversationError("DUPLICATE_MESSAGE_ID", {
              turnId: turn.id,
              messageId: message.id,
            });
          }
          messageIds.add(message.id);

          if (previousSequence !== undefined && stored.sequence <= previousSequence) {
            throw new AgentConversationError("MESSAGE_SEQUENCE_NOT_INCREASING", {
              turnId: turn.id,
              messageId: message.id,
            });
          }
          previousSequence = stored.sequence;

          if (message.runId !== turn.runId) {
            throw new AgentConversationError("MESSAGE_RUN_MISMATCH", {
              turnId: turn.id,
              messageId: message.id,
            });
          }
          if (message.sessionId !== turn.sessionId) {
            throw new AgentConversationError("MESSAGE_SESSION_MISMATCH", {
              turnId: turn.id,
              messageId: message.id,
            });
          }
          if (message.conversationTurnId !== turn.id) {
            throw new AgentConversationError("MESSAGE_TURN_MISMATCH", {
              turnId: turn.id,
              messageId: message.id,
            });
          }
        }

        /* ---- model-visible Tool structure ---- */
        validateModelVisibleToolStructure(turn);
      }

      /* ---- the current pair ---- */
      const currentRunTurns = snapshot.turns.filter((turn) => turn.runId === snapshot.currentRunId);
      if (currentRunTurns.length === 0) {
        throw new AgentConversationError("CURRENT_RUN_MISSING");
      }
      const currentTurn = turnById.get(snapshot.currentTurnId);
      if (currentTurn === undefined || currentTurn.runId !== snapshot.currentRunId) {
        throw new AgentConversationError("CURRENT_TURN_MISMATCH", {
          turnId: snapshot.currentTurnId,
        });
      }
    },
  };
}

/**
 * Validate the Tool protocol over one turn's *model-visible* messages.
 *
 * ```text
 * a toolCallId is announced by exactly one model-visible assistant message
 * every announced call is answered exactly once, by a model-visible result
 * no model-visible result answers a call that was never announced
 * a result names the same tool the call named
 * ```
 *
 * The last rule matters because the provider is told both: a result attributed to the wrong
 * Tool would let a model conclude that `read_file` produced `exec_command`'s output.
 *
 * A hidden message between an announcement and its answer is *fine* here: it is filtered out
 * before this pass runs, so it can neither break the pairing nor be mistaken for one.
 */
function validateModelVisibleToolStructure(turn: ConversationTurn): void {
  /** Announcement order matters only for reporting; identity is the toolCallId. */
  const announced = new Map<string, string>();
  const answered = new Set<string>();

  for (const stored of turn.messages) {
    const message: AgentMessage = stored.message;
    if (!message.audience.model) continue;

    if (message.type === "ASSISTANT") {
      for (const part of message.content) {
        if (part.type !== "TOOL_CALL") continue;
        if (announced.has(part.toolCallId)) {
          // Two model-visible announcements of one id: the answers that follow cannot be
          // paired unambiguously, so the model's Tool protocol has no meaning here.
          throw new AgentConversationError("DUPLICATE_TOOL_CALL_ID", {
            turnId: turn.id,
            messageId: message.id,
          });
        }
        announced.set(part.toolCallId, part.toolName);
      }
      continue;
    }

    if (message.type === "TOOL_RESULT") {
      const expectedToolName = announced.get(message.toolCallId);
      if (expectedToolName === undefined) {
        throw new AgentConversationError("ORPHAN_TOOL_RESULT", {
          turnId: turn.id,
          messageId: message.id,
        });
      }
      if (answered.has(message.toolCallId)) {
        throw new AgentConversationError("DUPLICATE_TOOL_RESULT", {
          turnId: turn.id,
          messageId: message.id,
        });
      }
      if (message.toolName !== expectedToolName) {
        throw new AgentConversationError("TOOL_RESULT_NAME_MISMATCH", {
          turnId: turn.id,
          messageId: message.id,
        });
      }
      answered.add(message.toolCallId);
    }
  }

  for (const [toolCallId, toolName] of announced) {
    if (answered.has(toolCallId)) continue;
    // Unanswered. Two ways this can happen and both are refusals: nothing answered it at
    // all, or something did and the answer is hidden from the model. The second arm is the
    // one worth naming precisely, because it looks valid in the durable ledger.
    const hiddenAnswer = turn.messages.some(
      (stored) =>
        stored.message.type === "TOOL_RESULT" &&
        stored.message.toolCallId === toolCallId &&
        stored.message.toolName === toolName &&
        !stored.message.audience.model,
    );
    throw new AgentConversationError(
      hiddenAnswer ? "MODEL_VISIBLE_RESULT_REQUIRED" : "MISSING_TOOL_RESULT",
      { turnId: turn.id },
    );
  }
}
