import { describe, expect, it } from "vitest";

import {
  assertAIConversationMessage,
  assertAIContent,
  assertAIMessage,
  assertAIMessages,
  assertAIAssistantContent,
  assertAIProviderOpaqueState,
  isAIContent,
  isAIAssistantContent,
  providerStateMatches,
  AI_PROVIDER_OPAQUE_STATE_VERSION,
} from "@caelush/ai";
import type {
  AIAssistantMessage,
  AIConversationMessage,
  AIContent,
  AIMessage,
  AIProviderOpaqueState,
  AITextContent,
  AIToolCallContent,
} from "@caelush/ai";

/**
 * Phase 5A — the additive refinement of the frozen AI message contract.
 *
 * Every test here exists to prove that the refinement is *additive*: the messages Phase 2A
 * shipped still validate, the names Phase 2A shipped still resolve, and the new capabilities
 * (provider opaque state, the conversation union, the canonical content names) are additions
 * rather than a second implementation.
 */

const STATE_ALPHA: AIProviderOpaqueState = {
  providerId: "provider-alpha",
  api: "alpha-messages",
  version: 1,
  payload: { signature: "opaque-blob", reasoning: [1, 2, 3] },
};

const STATE_BETA: AIProviderOpaqueState = {
  providerId: "provider-beta",
  api: "beta-chat",
  version: 1,
  payload: { signature: "different-blob" },
};

describe("Phase 5A AI — canonical content names", () => {
  it("keeps the frozen text and tool-call shapes", () => {
    const text: AITextContent = { type: "text", text: "hello" };
    const toolCall: AIToolCallContent = {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "read_file",
      input: { path: "a.ts" },
    };
    expect(() => {
      assertAIContent(text);
      assertAIContent(toolCall);
    }).not.toThrow();
  });

  it("accepts the same shapes under the Phase 2A compatibility names", () => {
    // Both names must resolve to the same declaration: if they were two interfaces, a value
    // satisfying one could fail the other's validator.
    const asCanonical: AIContent = { type: "text", text: "x" };
    const asLegacy: AIMessage = { role: "assistant", content: [asCanonical] };
    expect(() => {
      assertAIAssistantContent({ type: "text", text: "x" });
      assertAIMessage(asLegacy);
    }).not.toThrow();
    expect(isAIAssistantContent({ type: "text", text: "x" })).toBe(true);
    expect(isAIContent({ type: "text", text: "x" })).toBe(true);
    expect(isAIContent({ type: "text", text: 1 })).toBe(false);
    expect(isAIContent({ type: "image", data: "x" })).toBe(false);
  });

  it("refuses a content list where a single content part is required", () => {
    expect(() => {
      assertAIContent([{ type: "text", text: "x" }]);
    }).toThrow(TypeError);
  });

  it("still rejects unknown keys on a content part", () => {
    expect(() => {
      assertAIContent({ type: "text", text: "x", smuggled: true });
    }).toThrow(TypeError);
    expect(() => {
      assertAIContent({ type: "tool-call", toolCallId: "c", toolName: "t", input: {}, extra: 1 });
    }).toThrow(TypeError);
  });
});

describe("Phase 5A AI — provider opaque state", () => {
  it("accepts a well-formed state and pins the envelope version", () => {
    expect(() => {
      assertAIProviderOpaqueState(STATE_ALPHA);
    }).not.toThrow();
    expect(AI_PROVIDER_OPAQUE_STATE_VERSION).toBe(1);
  });

  it("rejects an empty provider identity", () => {
    for (const broken of [
      { ...STATE_ALPHA, providerId: "" },
      { ...STATE_ALPHA, api: "" },
    ]) {
      expect(() => {
        assertAIProviderOpaqueState(broken);
      }).toThrow(TypeError);
    }
  });

  it("rejects any envelope version but 1", () => {
    for (const version of [0, 2, "1", 1.5, null]) {
      expect(() => {
        assertAIProviderOpaqueState({ ...STATE_ALPHA, version });
      }).toThrow(TypeError);
    }
  });

  it("rejects a payload that is not JSON-safe", () => {
    for (const payload of [[], null, "text", { nested: () => undefined }, { n: Number.NaN }]) {
      expect(() => {
        assertAIProviderOpaqueState({ ...STATE_ALPHA, payload });
      }).toThrow(TypeError);
    }
  });

  it("rejects an unknown key, so no unvalidated state can be carried", () => {
    expect(() => {
      assertAIProviderOpaqueState({ ...STATE_ALPHA, extra: true });
    }).toThrow(TypeError);
  });

  it("matches a state only to its own provider and API dialect", () => {
    expect(providerStateMatches(STATE_ALPHA, "provider-alpha", "alpha-messages")).toBe(true);
    expect(providerStateMatches(STATE_ALPHA, "provider-beta", "alpha-messages")).toBe(false);
    expect(providerStateMatches(STATE_ALPHA, "provider-alpha", "beta-chat")).toBe(false);
  });
});

describe("Phase 5A AI — assistant providerState", () => {
  it("accepts an assistant message with and without state", () => {
    const without: AIAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
    };
    const withState: AIAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      providerState: STATE_ALPHA,
    };
    expect(() => {
      assertAIMessage(without);
      assertAIMessage(withState);
    }).not.toThrow();
  });

  it("keeps content.length >= 1 with state present", () => {
    expect(() => {
      assertAIMessage({ role: "assistant", content: [], providerState: STATE_ALPHA });
    }).toThrow(TypeError);
  });

  it("keeps strict unknown-key rejection when state is present", () => {
    expect(() => {
      assertAIMessage({
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        providerState: STATE_ALPHA,
        smuggled: true,
      });
    }).toThrow(TypeError);
  });

  it("rejects a malformed state on an otherwise valid assistant message", () => {
    expect(() => {
      assertAIMessage({
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        providerState: { ...STATE_ALPHA, version: 3 },
      });
    }).toThrow(TypeError);
  });

  it("does not accept providerState on a role that has no such field", () => {
    expect(() => {
      assertAIMessage({ role: "user", content: "x", providerState: STATE_ALPHA });
    }).toThrow(TypeError);
    expect(() => {
      assertAIMessage({
        role: "tool",
        toolCallId: "c",
        toolName: "t",
        content: "x",
        isError: false,
        providerState: STATE_ALPHA,
      });
    }).toThrow(TypeError);
  });
});

describe("Phase 5A AI — the conversation union excludes system", () => {
  it("treats a system message as a valid AIMessage", () => {
    const messages: AIMessage[] = [
      { role: "system", content: "you are caelush" },
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "tool", toolCallId: "c1", toolName: "t", content: "out", isError: false },
    ];
    expect(() => {
      assertAIMessages(messages);
    }).not.toThrow();
  });

  it("treats a system message as an invalid AIConversationMessage", () => {
    // This is the type-level rule that makes system injection impossible for a projector,
    // asserted at run time as well because a projector is an injected boundary.
    expect(() => {
      assertAIConversationMessage({ role: "system", content: "x" });
    }).toThrow(TypeError);

    for (const message of [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "tool", toolCallId: "c1", toolName: "t", content: "out", isError: false },
    ]) {
      expect(() => {
        assertAIConversationMessage(message);
      }).not.toThrow();
    }
  });

  it("collects the three conversation arms in one union", () => {
    const conversation: AIConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "tool", toolCallId: "c1", toolName: "t", content: "out", isError: false },
    ];
    expect(conversation).toHaveLength(3);
  });
});

describe("Phase 5A AI — provider switch safety (freeze §22)", () => {
  it("retains the semantic assistant message when the opaque state is another provider's", () => {
    // A state minted by provider alpha is being considered by a beta translator. The rule is
    // that the *state* is ignored, never the message: dropping the assistant turn would
    // discard real conversation because of an envelope the receiving dialect cannot read.
    const message: AIAssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "a.ts" } },
      ],
      providerState: STATE_ALPHA,
    };

    assertAIMessage(message);
    const receivingProvider = STATE_BETA.providerId;
    const receivingApi = STATE_BETA.api;

    // The state is optional on the message, so the predicate is only asked when one is there.
    // That is exactly the adapter's shape: no state, nothing to match, nothing to drop.
    if (message.providerState === undefined) throw new Error("expected a carried state");
    const stateUsable = providerStateMatches(
      message.providerState,
      receivingProvider,
      receivingApi,
    );
    expect(stateUsable).toBe(false);

    // The semantic content is untouched by the mismatch.
    expect(message.content).toHaveLength(2);
    expect(message.content[0]).toEqual({ type: "text", text: "let me look" });
    expect(message.content[1]).toEqual({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "read_file",
      input: { path: "a.ts" },
    });
  });

  it("keeps the message valid with the state simply absent", () => {
    const stripped: AIAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "let me look" }],
    };
    expect(() => {
      assertAIMessage(stripped);
    }).not.toThrow();
  });
});
