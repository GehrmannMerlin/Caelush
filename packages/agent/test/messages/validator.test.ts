import { describe, expect, it } from "vitest";

import {
  AgentConversationError,
  agentConversationErrorMessage,
  createAgentConversationSnapshot,
  createAgentConversationValidator,
  createConversationTurn,
  AGENT_CONVERSATION_VIOLATION_REASONS,
} from "@caelush/agent";
import type {
  AgentConversationSnapshot,
  AgentConversationViolationReason,
  StoredAgentMessage,
} from "@caelush/agent";

import {
  CREATED_AT,
  OBSERVATION_ID,
  OTHER_RUN_ID,
  RUN_ID,
  SESSION_ID,
  assistantMessage,
  factory,
  snapshot,
  stored,
  toolMessageSource,
  toolResultObservation,
  RECEIPT,
  toolResultMessage,
  turn,
  turnIdFor,
  userMessage,
} from "./fixtures.js";

/**
 * Phase 5A — the target Message V2 conversation authority. Freeze §105 to §110, §145.
 *
 * The two structural questions are tested separately throughout, because keeping them
 * separate is what stops a hidden message from manufacturing a fake orphan:
 *
 * ```text
 * durable structure        every message in every turn
 * model-visible structure  only messages with audience.model = true
 * ```
 */

const validate = createAgentConversationValidator();

function expectViolation(
  conversation: AgentConversationSnapshot,
  reason: AgentConversationViolationReason,
): void {
  let thrown: unknown;
  try {
    validate.validate(conversation);
  } catch (error) {
    thrown = error;
  }
  // Captured before asserting, so a missing violation reports "nothing was thrown" rather
  // than failing on a sentinel the helper itself raised.
  expect(thrown, reason).toBeInstanceOf(AgentConversationError);
  expect((thrown as AgentConversationError).reason, reason).toBe(reason);
}

/** A turn whose messages are renumbered from 1, which is the shape a real store returns. */
function sequenced(messages: readonly StoredAgentMessage[]): readonly StoredAgentMessage[] {
  return messages.map((entry, index) => ({ ...entry, sequence: index + 1 }));
}

describe("Phase 5A validator — the valid shapes", () => {
  it("accepts a user then assistant conversation", () => {
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ text: "hello", sequence: 2 }),
    ]);
    expect(() => validate.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("accepts a tool call answered by one tool result", () => {
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
    ]);
    expect(() => validate.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("accepts a multi-tool call answered by every result", () => {
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1", "call_2", "call_3"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      toolResultMessage({ toolCallId: "call_2", toolName: "tool_1", sequence: 4 }),
      toolResultMessage({ toolCallId: "call_3", toolName: "tool_2", sequence: 5 }),
    ]);
    expect(() => validate.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("accepts an unanswered tool call as an OPEN execution unit, not an error", () => {
    // An in-flight batch is a legitimate durable state: the calls are announced and the
    // results have not arrived. Refusing it would reject every conversation a recovery loads.
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
    ]);
    expect(() => validate.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("accepts a partially answered multi-tool batch", () => {
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1", "call_2"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
    ]);
    expect(() => validate.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("accepts two turns of one Session in Run order", () => {
    const first = turn(
      sequenced([userMessage({ sequence: 1 }), assistantMessage({ text: "a", sequence: 2 })]),
      { openedAt: 1 },
    );
    const second = turn(
      sequenced([
        userMessage({ sequence: 1, runId: OTHER_RUN_ID }),
        assistantMessage({ text: "b", sequence: 2, runId: OTHER_RUN_ID }),
      ]),
      { runId: OTHER_RUN_ID, openedAt: 2 },
    );
    const conversation = createAgentConversationSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: OTHER_RUN_ID as never,
      currentTurnId: turnIdFor(OTHER_RUN_ID),
      turns: [first, second],
    });
    expect(() => validate.validate(conversation)).not.toThrow();
  });

  it("exposes a closed reason set with a safe message for each", () => {
    expect(AGENT_CONVERSATION_VIOLATION_REASONS.length).toBe(18);
    for (const reason of AGENT_CONVERSATION_VIOLATION_REASONS) {
      const message = agentConversationErrorMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      // No reason text quotes conversation content.
      expect(message).not.toContain("tool output");
    }
  });
});

describe("Phase 5A validator — durable structure violations", () => {
  it("refuses a duplicated message id across the whole snapshot", () => {
    const message = userMessage({ sequence: 1 });
    const duplicated: StoredAgentMessage = { ...message, sequence: 2 };
    expectViolation(snapshot([turn([message, duplicated])]), "DUPLICATE_MESSAGE_ID");
  });

  it("refuses a non-increasing sequence inside one turn", () => {
    const first = userMessage({ sequence: 5 });
    const second = assistantMessage({ text: "hi", sequence: 5 });
    expectViolation(snapshot([turn([first, second])]), "MESSAGE_SEQUENCE_NOT_INCREASING");
  });

  it("refuses a message whose Run disagrees with its turn", () => {
    const message = userMessage({ sequence: 1 });
    const mismatched: StoredAgentMessage = {
      ...message,
      message: { ...message.message, runId: OTHER_RUN_ID as never },
    };
    expectViolation(snapshot([turn([mismatched])]), "MESSAGE_RUN_MISMATCH");
  });

  it("refuses a message whose session disagrees with its turn", () => {
    const message = userMessage({ sequence: 1 });
    const mismatched: StoredAgentMessage = {
      ...message,
      message: {
        ...message.message,
        sessionId: "ses_0192f5b1-4d3a-7c2e-8a91-000000000000" as never,
      },
    };
    expectViolation(snapshot([turn([mismatched])]), "MESSAGE_SESSION_MISMATCH");
  });

  it("refuses a message whose conversation turn disagrees with the turn it is stored in", () => {
    const message = userMessage({ sequence: 1 });
    const mismatched: StoredAgentMessage = {
      ...message,
      message: { ...message.message, conversationTurnId: turnIdFor(OTHER_RUN_ID) },
    };
    expectViolation(snapshot([turn([mismatched])]), "MESSAGE_TURN_MISMATCH");
  });

  it("refuses a duplicate turn id", () => {
    const messages = sequenced([userMessage({ sequence: 1 })]);
    const conversation = snapshot([turn(messages), turn(messages)]);
    expectViolation(conversation, "DUPLICATE_TURN_ID");
  });

  it("refuses a turn whose session disagrees with the snapshot", () => {
    const messages = sequenced([userMessage({ sequence: 1 })]);
    const conversation = snapshot([
      turn(messages, { sessionId: "ses_0192f5b1-4d3a-7c2e-8a91-000000000000" }),
    ]);
    expectViolation(conversation, "TURN_SESSION_MISMATCH");
  });

  it("refuses turns that are not ordered by opening time then identity", () => {
    const first = turn(
      sequenced([
        userMessage({ sequence: 1, runId: OTHER_RUN_ID }),
        assistantMessage({ text: "a", sequence: 2, runId: OTHER_RUN_ID }),
      ]),
      { runId: OTHER_RUN_ID, openedAt: 5 },
    );
    const second = turn(sequenced([userMessage({ sequence: 1 })]), { openedAt: 1 });
    const conversation = createAgentConversationSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
      currentTurnId: turnIdFor(RUN_ID),
      turns: [first, second],
    });
    expectViolation(conversation, "TURN_ORDER_INVALID");
  });

  it("refuses a snapshot whose current Run has no turn", () => {
    const conversation = createAgentConversationSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: OTHER_RUN_ID as never,
      currentTurnId: turnIdFor(OTHER_RUN_ID),
      turns: [turn(sequenced([userMessage({ sequence: 1 })]))],
    });
    expectViolation(conversation, "CURRENT_RUN_MISSING");
  });

  it("refuses a snapshot whose current turn belongs to another Run", () => {
    const conversation = createAgentConversationSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
      currentTurnId: turnIdFor("run_0192f5b1-4d3a-7c2e-8a91-000000000009" as never),
      turns: [turn(sequenced([userMessage({ sequence: 1 })]))],
    });
    expectViolation(conversation, "CURRENT_TURN_MISMATCH");
  });

  it("refuses an empty session identity", () => {
    const conversation = createAgentConversationSnapshot({
      sessionId: "" as never,
      currentRunId: RUN_ID as never,
      currentTurnId: turnIdFor(RUN_ID),
      turns: [],
    });
    expectViolation(conversation, "EMPTY_SESSION_ID");
  });
});

describe("Phase 5A validator — model-visible Tool structure", () => {
  it("refuses a tool call announced twice by one model-visible assistant message", () => {
    // The message itself refuses this at construction, so the violation is reached by
    // modelling an already-stored row whose content claims the same id twice.
    const assistant = assistantMessage({ toolCalls: ["call_1", "call_2"], sequence: 2 }).message;
    const duplicated = {
      ...assistant,
      content: assistant.content.map((part) =>
        part.type === "TOOL_CALL" ? { ...part, toolCallId: "call_1" } : part,
      ),
    };
    const messages: StoredAgentMessage[] = [
      { ...userMessage({ sequence: 1 }) },
      { sequence: 2, schemaVersion: 1, modelProjectionVersion: 1, message: duplicated as never },
      toolResultMessage({ toolCallId: "call_1", sequence: 3 }),
    ];
    expectViolation(snapshot([turn(messages)]), "DUPLICATE_TOOL_CALL_ID");
  });

  it("refuses an orphan tool result with no announced call", () => {
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      toolResultMessage({ toolCallId: "call_ghost", sequence: 2 }),
    ]);
    expectViolation(snapshot([turn(messages)]), "ORPHAN_TOOL_RESULT");
  });

  it("refuses a tool result that answers a call twice", () => {
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 4 }),
    ]);
    expectViolation(snapshot([turn(messages)]), "DUPLICATE_TOOL_RESULT");
  });

  it("refuses a tool result that names a different tool than the call", () => {
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "wrong_tool", sequence: 3 }),
    ]);
    expectViolation(snapshot([turn(messages)]), "TOOL_RESULT_NAME_MISMATCH");
  });

  it("refuses a model-visible tool call answered only by a hidden result (freeze §107)", () => {
    // The call is live from the model's perspective: nothing model-visible followed it until
    // the next user turn. When that turn arrives, the batch must have been answered — and a
    // hidden answer does not count, because the provider would receive a request whose Tool
    // protocol is incomplete.
    const messages: StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      stored(toolResultMessage({ toolCallId: "call_1", toolName: "tool_0" }).message, 3, false),
      userMessage({ text: "still waiting?", sequence: 4 }),
    ];
    expectViolation(snapshot([turn(messages)]), "MODEL_VISIBLE_RESULT_REQUIRED");
  });

  it("refuses a model-visible tool call answered only by a hidden result after narration", () => {
    // Same shape, with the continuation being model narration rather than a user turn.
    const messages: StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      stored(toolResultMessage({ toolCallId: "call_1", toolName: "tool_0" }).message, 3, false),
      assistantMessage({ text: "carrying on", sequence: 4 }),
    ];
    expectViolation(snapshot([turn(messages)]), "MODEL_VISIBLE_RESULT_REQUIRED");
  });

  it("accepts a hidden custom message between a call and its visible result (freeze §108)", () => {
    const hidden = stored(userMessage({ text: "ui only", sequence: 3 }).message, 3, false);
    const messages: StoredAgentMessage[] = [
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      { ...hidden, sequence: 3 },
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 4 }),
    ];
    // The hidden message must not create a fake orphan, and must not break the pairing.
    expect(() => validate.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("ignores a hidden tool result that answers no visible call", () => {
    // A hidden result is not part of the model-visible Tool ledger; treating it as an orphan
    // would refuse a conversation the model can be sent.
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ text: "no tools", sequence: 2 }),
      stored(toolResultMessage({ toolCallId: "call_hidden" }).message, 3, false),
    ]);
    expect(() => validate.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("refuses a call the conversation moved past without answering it (freeze §106)", () => {
    // The open-batch arm is legal only while it is the trailing model-visible material. Here
    // the model was asked to continue and never learned what the Tool returned.
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ text: "calling", toolCalls: ["call_1"], sequence: 2 }),
      assistantMessage({ text: "carrying on regardless", sequence: 3 }),
    ]);
    expectViolation(snapshot([turn(messages)]), "MISSING_TOOL_RESULT");
  });

  it("accepts the same batch while it is still the trailing material", () => {
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ text: "calling", toolCalls: ["call_1"], sequence: 2 }),
    ]);
    expect(() => validate.validate(snapshot([turn(messages)]))).not.toThrow();
  });

  it("does not consult the Run Layer or any host state", () => {
    // The validator is pure: the same snapshot validates identically twice, and no run status
    // is read, because Run status is not its authority.
    const messages = sequenced([
      userMessage({ sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({ toolCallId: "call_1", toolName: "tool_0", sequence: 3 }),
    ]);
    const conversation = snapshot([turn(messages)]);
    validate.validate(conversation);
    validate.validate(conversation);
  });
});

describe("Phase 5A validator — reasons do not quote conversation content", () => {
  it("keeps Tool output and user text out of the refusal", () => {
    const secret = "SUPER-SECRET-TOOL-OUTPUT";
    const messages = sequenced([
      userMessage({ text: "SUPER-SECRET-USER-TEXT", sequence: 1 }),
      assistantMessage({ toolCalls: ["call_1"], sequence: 2 }),
      toolResultMessage({
        toolCallId: "call_ghost",
        projectedContent: secret,
        sequence: 3,
      }),
    ]);
    let thrown: unknown;
    try {
      validate.validate(snapshot([turn(messages)]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentConversationError);
    const serialized = `${String(thrown)} ${JSON.stringify(thrown)}`;
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("SUPER-SECRET-USER-TEXT");
  });
});

describe("Phase 5A validator — turn versus execution unit (freeze §102)", () => {
  it("keeps the two concepts distinct in their documented roles", () => {
    // A turn is provenance — what belongs to which Run — and may end with an open batch.
    const open = turn(
      sequenced([
        userMessage({ sequence: 1 }),
        assistantMessage({ toolCalls: ["c1"], sequence: 2 }),
      ]),
    );
    expect(open.id).toBe(turnIdFor(RUN_ID));

    // An execution unit is the Tool protocol obligation inside a turn; it never spans Runs.
    const builder = factory();
    const crossRunAttempt = builder.createToolResult({
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      conversationTurnId: turnIdFor(RUN_ID),
      source: toolMessageSource(),
      toolCallId: "c1",
      toolName: "t",
      observation: toolResultObservation(OBSERVATION_ID as never),
      isError: false,
      projectedContent: "x",
      projection: RECEIPT,
    });
    expect(crossRunAttempt.runId).toBe(RUN_ID);
  });

  it("builds a turn only from a non-empty identity and a consistent status pair", () => {
    expect(() =>
      createConversationTurn({
        id: "" as never,
        sessionId: SESSION_ID as never,
        runId: RUN_ID as never,
        status: "OPEN",
        openedAt: CREATED_AT as never,
        messages: [],
      }),
    ).toThrow(TypeError);

    expect(() =>
      createConversationTurn({
        id: turnIdFor(),
        sessionId: SESSION_ID as never,
        runId: RUN_ID as never,
        status: "CLOSED",
        openedAt: CREATED_AT as never,
        messages: [],
      }),
    ).toThrow(TypeError);

    expect(() =>
      createConversationTurn({
        id: turnIdFor(),
        sessionId: SESSION_ID as never,
        runId: RUN_ID as never,
        status: "OPEN",
        openedAt: CREATED_AT as never,
        closedAt: CREATED_AT as never,
        messages: [],
      }),
    ).toThrow(TypeError);
  });
});
