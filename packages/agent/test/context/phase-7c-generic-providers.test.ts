import { describe, expect, it } from "vitest";

import {
  AGENT_CONTEXT_SOURCE_IDS,
  createBranchContextSourceProvider,
  createCheckpointContextSourceProvider,
  createConversationContextSourceProvider,
  createExtensionContributionContextSourceProvider,
  createMemoryContextSourceProvider,
  createStructuredCheckpoint,
  type ContextContribution,
  type ContextSourceInput,
} from "@caelush/agent";
import {
  RUN_ID,
  SESSION_ID,
  assistantMessage,
  snapshot,
  toolResultMessage,
  turn,
  userMessage,
} from "../messages/fixtures.js";

const conversation = snapshot([
  turn([
    userMessage({ sequence: 1 }),
    assistantMessage({ sequence: 2, text: "I will inspect the workspace." }),
    toolResultMessage({ sequence: 3 }),
    assistantMessage({ sequence: 4, text: "hidden detail", modelVisible: false }),
  ]),
]);

const sourceInput = {
  identity: {
    runId: RUN_ID as never,
    sessionId: SESSION_ID as never,
    goal: "inspect the workspace",
  },
  turn: { stepId: "step_1" as never, sequence: 1 },
  conversation,
  input: { kind: "USER_INPUT", userMessageId: conversation.turns[0]!.messages[0]!.message.id },
  model: {} as never,
  mode: "NORMAL",
  policy: {} as never,
  signal: new AbortController().signal,
} as unknown as ContextSourceInput;

describe("Phase 7C Generic Source Providers", () => {
  it("projects only model-visible durable messages with stable identities", async () => {
    const provider = createConversationContextSourceProvider();
    const result = await provider.collect(sourceInput);

    expect(provider.id).toBe(AGENT_CONTEXT_SOURCE_IDS.conversation);
    expect(result.providerId).toBe(AGENT_CONTEXT_SOURCE_IDS.conversation);
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.payload.kind)).toEqual([
      "AGENT_MESSAGE",
      "AGENT_MESSAGE",
      "AGENT_MESSAGE",
    ]);
    expect(result.items.map((item) => item.id)).toEqual([
      `agent.conversation:${conversation.turns[0]!.messages[0]!.message.id}`,
      `agent.conversation:${conversation.turns[0]!.messages[1]!.message.id}`,
      `agent.conversation:${conversation.turns[0]!.messages[2]!.message.id}`,
    ]);
    expect(result.items.map((item) => item.source.providerId)).toEqual([
      AGENT_CONTEXT_SOURCE_IDS.conversation,
      AGENT_CONTEXT_SOURCE_IDS.conversation,
      AGENT_CONTEXT_SOURCE_IDS.conversation,
    ]);
    expect(
      result.items[0]!.payload.kind === "AGENT_MESSAGE" && result.items[0]!.payload.message,
    ).toEqual(conversation.turns[0]!.messages[0]);
    expect(result.items[0]!.scope).toBe("SESSION");
    expect(result.items[0]!.retention).toBe("COMPRESSIBLE");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
  });

  it("adapts an injected checkpoint loader into one rehydratable item", async () => {
    let received:
      | { readonly identity: ContextSourceInput["identity"]; readonly signal: AbortSignal }
      | undefined;
    const provider = createCheckpointContextSourceProvider({
      loader: {
        async load(input) {
          received = input;
          return {
            checkpointId: "checkpoint_1",
            sourceRef: "run/checkpoint_1",
            version: "checkpoint-v1",
            checkpoint: createStructuredCheckpoint({
              version: 1,
              goal: "checkpoint goal",
              constraints: [],
              completedWork: [],
              inProgress: [],
              blocked: [],
              importantDiscoveries: [],
              keyDecisions: [],
              changedFiles: [],
              readFiles: [],
              recentErrors: [],
              verificationState: "unknown",
              activeProcesses: [],
              pendingApprovals: [],
              resourceGovernance: "bounded",
              criticalReferences: [],
              nextIntent: "continue",
              sourceRange: { from: 3, to: 3 },
            }),
          };
        },
      },
    });

    const result = await provider.collect(sourceInput);

    expect(received?.identity).toBe(sourceInput.identity);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "agent.checkpoint:checkpoint_1",
      type: "agent.checkpoint",
      scope: "RUN",
      retention: "REHYDRATABLE",
      priorityClass: "HIGH",
      source: {
        providerId: AGENT_CONTEXT_SOURCE_IDS.checkpoint,
        sourceRef: "run/checkpoint_1",
        version: "checkpoint-v1",
      },
      payload: { kind: "CHECKPOINT", checkpoint: { goal: "checkpoint goal" } },
    });
  });

  it("projects memory loader records without importing memory authority", async () => {
    const provider = createMemoryContextSourceProvider({
      loader: {
        async load() {
          return [
            {
              id: "memory_1",
              sourceRef: "memory/project/memory_1",
              version: "memory-v2",
              text: "The repository uses strict package boundaries.",
              tokenEstimate: 9,
              freshness: "STALE",
            },
          ];
        },
      },
    });

    const result = await provider.collect(sourceInput);

    expect(result.items).toMatchObject([
      {
        id: "agent.memory:memory_1",
        type: "agent.memory",
        retention: "RETRIEVABLE",
        priorityClass: "LOW",
        cacheStability: "SEMI_STABLE",
        freshness: "STALE",
        payload: { kind: "TEXT", text: "The repository uses strict package boundaries." },
      },
    ]);
    expect(result.items[0]!.source).toEqual({
      providerId: AGENT_CONTEXT_SOURCE_IDS.memory,
      sourceRef: "memory/project/memory_1",
      version: "memory-v2",
    });
  });

  it("maps already-validated extension contributions without rerunning hooks", async () => {
    const contribution: ContextContribution = {
      id: "extension_1",
      source: "host.extension",
      replay: "SNAPSHOT",
      items: [
        {
          id: "fact_1",
          priorityClass: "HIGH",
          content: "The host supplied a bounded fact.",
          tokenEstimate: 7,
          whyLoaded: "host fact",
        },
      ],
    };
    let calls = 0;
    const provider = createExtensionContributionContextSourceProvider({
      loader: {
        async load() {
          calls += 1;
          return [contribution];
        },
      },
    });

    const result = await provider.collect(sourceInput);

    expect(calls).toBe(1);
    expect(result.items).toMatchObject([
      {
        id: "agent.extension-contributions:extension_1:fact_1",
        type: "agent.extension-contribution",
        scope: "TURN",
        retention: "EPHEMERAL",
        priorityClass: "HIGH",
        payload: { kind: "TEXT", text: "The host supplied a bounded fact." },
        whyLoaded: "host fact",
      },
    ]);
    expect(result.items[0]!.source.sourceRef).toBe("host.extension/extension_1/fact_1");
  });

  it("keeps branch context as an explicit stable no-op", async () => {
    const provider = createBranchContextSourceProvider();
    const result = await provider.collect(sourceInput);

    expect(provider.id).toBe(AGENT_CONTEXT_SOURCE_IDS.branchContext);
    expect(result).toEqual({
      providerId: AGENT_CONTEXT_SOURCE_IDS.branchContext,
      providerVersion: "branch-context-noop-v1",
      items: [],
      diagnostics: [],
    });
  });
});
