import { describe, expect, it } from "vitest";

import type { ModelDescriptor } from "@caelush/ai";
import {
  AGENT_CONTEXT_SOURCE_IDS,
  ContextSourceCollectionError,
  collectContextSources,
  createContextDocumentBuilder,
  createContextHistoryIndexer,
  createContextPolicy,
  createContextSourceId,
  createContextSourceRegistryBuilder,
  createConversationContextSourceProvider,
  createMemoryContextSourceProvider,
  createBranchContextSourceProvider,
  planContext,
  type ContextSourceInput,
  type ContextSourceProvider,
} from "@caelush/agent";
import {
  OTHER_RUN_ID,
  RUN_ID,
  SESSION_ID,
  assistantMessage,
  snapshot,
  turn,
  userMessage,
} from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "test", model: "phase-7c-integration" },
  api: "test-api",
  limits: { contextWindowTokens: 12_000, maxOutputTokens: 512 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

function policy() {
  return createContextPolicy({
    model: MODEL,
    requestOverhead: { toolSchemaTokens: 0, protocolOverheadTokens: 0, totalTokens: 0 },
    options: { outputReserveTokens: 512, safetyReserveTokens: 128 },
  });
}

function sourceInput(conversation = snapshot([turn([userMessage({ sequence: 1 })])])) {
  return {
    identity: { runId: RUN_ID as never, sessionId: SESSION_ID as never, goal: "integration" },
    turn: { stepId: "step_1" as never, sequence: 1 },
    conversation,
    input: {
      kind: "USER_INPUT" as const,
      userMessageId: conversation.turns.at(-1)!.messages[0]!.message.id,
    },
    model: MODEL,
    mode: "NORMAL" as const,
    policy: policy(),
    signal: new AbortController().signal,
  } satisfies ContextSourceInput;
}

function rehydrated() {
  return {
    goal: "",
    changedFiles: [],
    pendingApprovals: [],
    activeProcesses: [],
    verificationState: "",
    resourceGovernance: "",
    projectFacts: [],
  };
}

describe("Phase 7C Agent source target path", () => {
  it("collects Generic Sources through Registry → Planner → Document", async () => {
    const input = sourceInput();
    const conversationProvider = createConversationContextSourceProvider();
    const memoryProvider = createMemoryContextSourceProvider({
      loader: {
        async load() {
          return [
            {
              id: "memory_1",
              sourceRef: "memory:project_1/memory_1",
              version: "memory-v1",
              text: "A bounded project fact.",
              tokenEstimate: 6,
            },
          ];
        },
      },
    });
    const registry = createContextSourceRegistryBuilder()
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.conversation,
        priority: 0,
        criticality: "REQUIRED",
        provider: conversationProvider,
      })
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.memory,
        priority: 10,
        criticality: "OPTIONAL",
        provider: memoryProvider,
      })
      .register({
        id: AGENT_CONTEXT_SOURCE_IDS.branchContext,
        priority: 20,
        criticality: "OPTIONAL",
        provider: createBranchContextSourceProvider(),
      })
      .build();

    const results = await collectContextSources(registry, input);
    const items = results.flatMap((result) => result.items);
    const history = createContextHistoryIndexer().index({
      conversation: input.conversation,
      model: MODEL,
    });
    const plan = planContext({
      items,
      policy: input.policy,
      history,
      currentTurnId: input.conversation.currentTurnId,
    });
    const document = createContextDocumentBuilder().build({ plan, rehydrated: rehydrated() });

    expect(results.map((result) => result.providerId)).toEqual([
      AGENT_CONTEXT_SOURCE_IDS.conversation,
      AGENT_CONTEXT_SOURCE_IDS.memory,
      AGENT_CONTEXT_SOURCE_IDS.branchContext,
    ]);
    expect(document.sections.length).toBeGreaterThan(0);
    expect(document.sections.map((section) => section.authority)).toEqual(
      expect.arrayContaining(["REFERENCE"]),
    );
    expect(
      document.sections.some((section) => section.sourceRef.includes("agent.conversation")),
    ).toBe(true);
    expect(document.sections.some((section) => section.sourceRef.includes("agent.memory"))).toBe(
      true,
    );
  });

  it("preserves current conversation tail through the history-aware planner", async () => {
    const oldUser = userMessage({ runId: OTHER_RUN_ID, sequence: 1, text: "old request" });
    const oldAssistant = assistantMessage({
      runId: OTHER_RUN_ID,
      sequence: 2,
      text: "old answer",
    });
    const oldTurn = turn([oldUser, oldAssistant], {
      runId: OTHER_RUN_ID,
      status: "CLOSED",
      openedAt: 1,
    });
    const currentUser = userMessage({ sequence: 1, text: "current request" });
    const conversation = snapshot([oldTurn, turn([currentUser], { openedAt: 2 })]);
    const input = sourceInput(conversation);
    const result = await createConversationContextSourceProvider().collect(input);
    const history = createContextHistoryIndexer().index({ conversation, model: MODEL });
    const plan = planContext({
      items: result.items,
      policy: policy(),
      history,
      currentTurnId: conversation.currentTurnId,
    });

    expect(
      plan.selectedItems.some(
        (item) =>
          item.payload.kind === "AGENT_MESSAGE" &&
          item.payload.message.message.id === currentUser.message.id,
      ),
    ).toBe(true);
  });

  it("keeps registry ordering deterministic and collection sequential", async () => {
    const events: string[] = [];
    const provider = (id: string): ContextSourceProvider => ({
      id: createContextSourceId(id),
      async collect() {
        events.push(id);
        return {
          providerId: createContextSourceId(id),
          providerVersion: "test-v1",
          items: [],
          diagnostics: [],
        };
      },
    });
    const registry = createContextSourceRegistryBuilder()
      .register({
        id: createContextSourceId("test.zeta"),
        priority: 1,
        criticality: "OPTIONAL",
        provider: provider("test.zeta"),
      })
      .register({
        id: createContextSourceId("test.alpha"),
        priority: 1,
        criticality: "OPTIONAL",
        provider: provider("test.alpha"),
      })
      .build();

    const results = await collectContextSources(registry, sourceInput());

    expect(events).toEqual(["test.alpha", "test.zeta"]);
    expect(results.map((result) => result.providerId)).toEqual([
      createContextSourceId("test.alpha"),
      createContextSourceId("test.zeta"),
    ]);
  });

  it("applies Required/Optional failure authority, cancellation, and ownership validation", async () => {
    const required = createContextSourceId("test.required");
    const requiredRegistry = createContextSourceRegistryBuilder()
      .register({
        id: required,
        priority: 0,
        criticality: "REQUIRED",
        provider: {
          id: required,
          async collect() {
            throw new Error("secret internal error");
          },
        },
      })
      .build();
    await expect(collectContextSources(requiredRegistry, sourceInput())).rejects.toMatchObject({
      sourceId: required,
      criticality: "REQUIRED",
    } satisfies Partial<ContextSourceCollectionError>);

    const optional = createContextSourceId("test.optional");
    const optionalRegistry = createContextSourceRegistryBuilder()
      .register({
        id: optional,
        priority: 0,
        criticality: "OPTIONAL",
        provider: {
          id: optional,
          async collect() {
            throw new Error("secret internal error");
          },
        },
      })
      .build();
    const optionalResult = await collectContextSources(optionalRegistry, sourceInput());
    expect(optionalResult[0]?.diagnostics).toEqual([
      {
        code: "SOURCE_FAILED",
        severity: "WARNING",
        message: "Optional context source failed.",
        sourceRef: optional,
      },
    ]);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      collectContextSources(optionalRegistry, { ...sourceInput(), signal: controller.signal }),
    ).rejects.toBeInstanceOf(Error);

    const mismatch = createContextSourceRegistryBuilder();
    expect(() =>
      mismatch.register({
        id: createContextSourceId("test.owner"),
        priority: 0,
        criticality: "OPTIONAL",
        provider: {
          id: createContextSourceId("test.other"),
          async collect() {
            return {
              providerId: createContextSourceId("test.other"),
              providerVersion: "v1",
              items: [],
              diagnostics: [],
            };
          },
        },
      }),
    ).toThrow(/provider id/i);
  });
});
