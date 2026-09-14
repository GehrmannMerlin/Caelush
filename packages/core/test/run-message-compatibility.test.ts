import type { AIMessage } from "@caelush/ai";
import type { LLMMessage } from "@caelush/llm/messages";
import { describe, expect, it } from "vitest";
import {
  toAgentAIMessage,
  toLegacyAssistantMessage,
  toLegacyDurableMessage,
  toLegacyToolResultMessage,
} from "../src/run-message-compatibility.js";

/**
 * The compatibility codec's contract, stated as parity.
 *
 * A projection earns its name only if the round trip is the identity on everything the canonical
 * contract carries, and if the persisted bytes are exactly the bytes the database has always
 * stored. Both halves are asserted here, message role by role, because a codec that quietly drops
 * a field is indistinguishable from one that works until a restarted Run disagrees with itself.
 */

const ROLES = [
  "system",
  "user",
  "assistant",
  "tool",
] as const satisfies readonly AIMessage["role"][];

describe("Run message compatibility codec", () => {
  it("round-trips every canonical role through the durable encoding", () => {
    const messages: readonly AIMessage[] = [
      { role: "system", content: "synthetic system context" },
      { role: "user", content: "inspect the project" },
      ...ROLES.filter((role) => role !== "system" && role !== "user").map(
        () => ({ role: "assistant", content: [{ type: "text", text: "done" }] }) as const,
      ),
      { role: "tool", toolCallId: "call_a", toolName: "read_file", content: "a", isError: false },
    ];

    for (const message of messages) {
      expect(toAgentAIMessage(toLegacyDurableMessage(message))).toEqual(message);
    }
  });

  it("keeps a plain assistant text turn byte-identical", () => {
    expect(
      toLegacyDurableMessage({ role: "assistant", content: [{ type: "text", text: "hello" }] }),
    ).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });

  it("preserves assistant ordering across text and tool calls", () => {
    const message: AIMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "tool-call", toolCallId: "call_a", toolName: "read_file", input: { path: "a" } },
        { type: "text", text: "second" },
        {
          type: "tool-call",
          toolCallId: "call_b",
          toolName: "list_directory",
          input: { path: "." },
        },
      ],
    };
    const projected = toLegacyAssistantMessage(message);

    // Content is copied in place: a durable ledger that reordered it would replay a different
    // request than the one the model answered.
    expect(projected.content.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "tool-call",
    ]);
    expect(toAgentAIMessage(projected)).toEqual(message);
  });

  it("preserves parallel tool-call identity, naming and arguments", () => {
    const message: AIMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_one",
          toolName: "read_file",
          input: { path: "a.ts" },
        },
        {
          type: "tool-call",
          toolCallId: "call_two",
          toolName: "search_text",
          input: { query: "x", limit: 5 },
        },
      ],
    };
    const restored = toAgentAIMessage(toLegacyDurableMessage(message));

    expect(restored).toEqual(message);
    expect(restored.role === "assistant" && restored.content).toHaveLength(2);
  });

  it("never stringifies tool arguments, so JSON scalar identity survives", () => {
    const message: AIMessage = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_json",
          toolName: "apply_patch",
          input: {
            n: 1,
            zero: 0,
            negative: -2,
            float: 1.5,
            yes: true,
            no: false,
            nothing: null,
            nested: { list: [1, "two", false, null, { deep: [] }] },
          },
        },
      ],
    };
    const persisted = toLegacyDurableMessage(message);
    const call = persisted.role === "assistant" ? persisted.content[0] : undefined;

    // The value crosses as JSON, never as text: `"1"` is not `1`, and `null` is not absent.
    expect(call).toEqual({
      type: "tool-call",
      toolCallId: "call_json",
      toolName: "apply_patch",
      input: {
        n: 1,
        zero: 0,
        negative: -2,
        float: 1.5,
        yes: true,
        no: false,
        nothing: null,
        nested: { list: [1, "two", false, null, { deep: [] }] },
      },
    });
    expect(toAgentAIMessage(persisted)).toEqual(message);
  });

  it("keeps the success and error distinction on a Tool result", () => {
    const success: AIMessage = {
      role: "tool",
      toolCallId: "call_ok",
      toolName: "read_file",
      content: "a.ts:1: hello",
      isError: false,
    };
    const failure: AIMessage = {
      role: "tool",
      toolCallId: "call_bad",
      toolName: "search_text",
      content: "Tool operation failed: RIPGREP_UNAVAILABLE.",
      isError: true,
    };

    expect(toAgentAIMessage(toLegacyDurableMessage(success))).toEqual(success);
    expect(toAgentAIMessage(toLegacyDurableMessage(failure))).toEqual(failure);
    // The distinction is persisted, not inferred from the text at load time.
    expect(toLegacyToolResultMessage(failure).isError).toBe(true);
  });

  it("projects a persisted Tool result that carries a raw artifact pointer without failing", () => {
    // The durable schema still accepts the pointer on rows written before Phase 3C, and those
    // rows must keep loading: the canonical contract has no field for it, so it is dropped
    // rather than smuggled into `content` or rejected as undecodable.
    const persisted: LLMMessage = {
      role: "tool",
      toolCallId: "call_legacy",
      toolName: "read_file",
      content: "bounded placeholder",
      isError: false,
      rawArtifactRef: "artifact:call_legacy",
    };

    expect(toAgentAIMessage(persisted)).toEqual({
      role: "tool",
      toolCallId: "call_legacy",
      toolName: "read_file",
      content: "bounded placeholder",
      isError: false,
    });
  });

  it("preserves an empty assistant content array as an empty array", () => {
    const message: AIMessage = { role: "assistant", content: [] };
    expect(toAgentAIMessage(toLegacyDurableMessage(message))).toEqual(message);
  });
});
