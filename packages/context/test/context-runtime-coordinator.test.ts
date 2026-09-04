import { describe, expect, it } from "vitest";
import { ContextRuntimeCoordinator } from "../src/context-runtime-coordinator.js";
import type { ContextCheckpointRecord } from "../src/context-persistence.js";
import type { ContextItem } from "../src/context-item.js";
import type { ContextBuildInput } from "../src/context-builder.js";

const checkpoint: ContextCheckpointRecord = {
  checkpointId: "checkpoint:1",
  runId: "run-1",
  schemaVersion: 1,
  sourceSequenceFrom: 1,
  sourceSequenceTo: 4,
  structuredCheckpoint: {
    version: 1,
    goal: "continue work",
    constraints: [],
    completedWork: ["inspect"],
    inProgress: [],
    blocked: [],
    importantDiscoveries: [],
    keyDecisions: [],
    changedFiles: [],
    readFiles: [],
    recentErrors: [],
    verificationState: "PENDING",
    activeProcesses: [],
    pendingApprovals: [],
    resourceGovernance: "NONE",
    criticalReferences: [],
    nextIntent: "continue",
    sourceRange: { from: 1, to: 4 },
  },
  tokensBefore: 2000,
  tokensAfter: 300,
  modelRef: { providerId: "fixture", modelId: "fixture-model" },
  createdAt: 10,
};

const memoryItem: ContextItem = {
  id: "memory:1",
  type: "MEMORY",
  sourceRef: "memory:1",
  scope: "PROJECT",
  retention: "RETRIEVABLE",
  priorityClass: "NORMAL",
  tokenEstimate: 3,
  cacheStability: "STABLE",
  freshness: "CURRENT",
  sensitivity: "PUBLIC",
  whyLoaded: "goal match",
  createdSequence: 1,
  updatedSequence: 1,
  content: "uses pnpm",
};

describe("ContextRuntimeCoordinator", () => {
  it("loads the latest checkpoint and scoped memory before building the model context", async () => {
    let received: ContextBuildInput | undefined;
    const coordinator = new ContextRuntimeCoordinator({
      builder: {
        build: (input) => {
          received = input;
          return { messages: [], report: {} as never };
        },
      },
      checkpointRepository: {
        getLatestByRun: async () => checkpoint,
      },
      memoryLoader: async (input) => {
        expect(input.projectId).toBe("project-1");
        expect(input.goal).toBe("continue work");
        return [memoryItem];
      },
    });

    const result = await coordinator.prepareModelContext({
      runId: "run-1",
      providerId: "fixture",
      modelId: "fixture-model",
      projectId: "project-1",
      context: {
        baseSystemPrompt: "base",
        snapshot: {} as never,
        limits: { maxInputTokens: 1000 },
        currentUserMessage: { role: "user", content: "continue work" },
      },
      signal: new AbortController().signal,
    });

    expect(received?.checkpoint).toEqual(checkpoint.structuredCheckpoint);
    expect(received?.memoryItems).toEqual([memoryItem]);
    expect(result.checkpoint?.checkpointId).toBe("checkpoint:1");
    expect(result.memoryItems).toEqual([memoryItem]);
  });

  it("compacts pressured history into a durable checkpoint before returning context", async () => {
    const builds: ContextBuildInput[] = [];
    const persisted: unknown[] = [];
    const coordinator = new ContextRuntimeCoordinator({
      builder: {
        build: (input) => {
          builds.push(input);
          return {
            messages: [],
            report: {
              trace: {
                contextWindow: 100,
                effectiveInputLimit: 80,
                estimatedInputTokens: builds.length === 1 ? 75 : 20,
                systemTokens: 5,
                goalTokens: 2,
                checkpointTokens: 0,
                recentTailTokens: 10,
                projectTokens: 5,
                fileTokens: 0,
                observationTokens: 0,
                memoryTokens: 0,
                droppedItems: 0,
                truncatedItems: 0,
                pressureRatio: builds.length === 1 ? 0.95 : 0.25,
                compactionCount: 0,
                loadedFileCount: 0,
                observationCount: 0,
              },
            },
          } as never;
        },
      },
      clock: { now: () => 42 },
      checkpointIdFactory: { create: () => "checkpoint:compacted" },
      checkpointRepository: {
        getLatestByRun: async () => undefined,
        create: async (input) => {
          persisted.push(input);
          return { ...checkpoint, checkpointId: input.checkpointId };
        },
      },
    });

    const history = Array.from({ length: 3 }, (_, index) => ({
      role: "user" as const,
      content: `old turn ${index}`,
    }));
    await coordinator.prepareModelContext({
      runId: "run-1",
      providerId: "fixture",
      modelId: "fixture-model",
      context: {
        baseSystemPrompt: "base",
        snapshot: {} as never,
        limits: { maxInputTokens: 1000 },
        history,
        currentUserMessage: { role: "user", content: "continue work" },
      },
      signal: new AbortController().signal,
    });

    expect(persisted).toHaveLength(1);
    expect(builds).toHaveLength(2);
    expect(builds[1]?.history).toEqual([]);
    expect(
      (persisted[0] as { readonly structuredCheckpoint: { readonly sourceRange: unknown } })
        .structuredCheckpoint.sourceRange,
    ).toEqual({ from: 0, to: 3 });
  });
});
