import { describe, expect, it } from "vitest";

import {
  createContextArtifactId,
  createContextItemId,
  createContextSourceId,
  type ContextArtifact,
  type ContextArtifactCreateInput,
  type ContextArtifactMetadata,
  type ContextArtifactStorePort,
  type ContextBuildReceipt,
  type ContextCompactionCommitPort,
  type ContextCompactionReceipt,
  type ContextSourceReceipt,
  type ContextUsageSnapshot,
  type ContextUsageStorePort,
} from "@caelush/agent";
import { createRunId, createTimestampMs } from "@caelush/protocol";

describe("Phase 7E Agent-owned contracts", () => {
  it("exposes one typed Artifact port without duplicating ContextArtifactId", () => {
    const input: ContextArtifactCreateInput = {
      artifactId: createContextArtifactId("artifact:v2:test"),
      runId: createRunId(),
      kind: "tool-output",
      sourceRef: "tool:exec",
      content: "bounded content",
      mimeType: "text/plain",
      sensitivity: "INTERNAL",
      createdSequence: 1,
      createdAt: createTimestampMs(1),
    };
    const metadata: ContextArtifactMetadata = {
      artifactId: input.artifactId!,
      runId: input.runId,
      kind: input.kind,
      sourceRef: input.sourceRef,
      mimeType: input.mimeType,
      sensitivity: input.sensitivity,
      createdSequence: input.createdSequence,
      createdAt: input.createdAt,
      contentHash: "sha256:content",
      byteLength: input.content.length,
    };
    const artifact: ContextArtifact = { ...metadata, content: input.content };
    const store: ContextArtifactStorePort = {
      async createOrGet() {
        return artifact;
      },
      async getMetadata() {
        return metadata;
      },
      async readInternal() {
        return artifact;
      },
      async readSafeProjection() {
        return "bounded content";
      },
    };

    expect(store).toBeDefined();
    expect(artifact.artifactId).toBe(createContextArtifactId("artifact:v2:test"));
  });

  it("keeps Receipt, Usage, and Compaction Commit contracts data-only and readonly", () => {
    const source: ContextSourceReceipt = {
      providerId: createContextSourceId("agent.conversation"),
      providerVersion: "v1",
      selectedItemIds: [createContextItemId("item:selected")],
      droppedItemIds: [],
      deferredItemIds: [],
    };
    const compaction: ContextCompactionReceipt = {
      reason: "PROACTIVE_PRESSURE",
      checkpoint: {
        checkpointId: "checkpoint:test" as never,
        schemaVersion: 2,
        sourceRange: {
          runId: createRunId(),
          conversationTurnId: "cturn:test" as never,
          firstMessageId: "amsg:first" as never,
          lastMessageId: "amsg:last" as never,
          firstSequence: 1,
          lastSequence: 2,
        },
        degraded: false,
      },
      tokensBefore: 100,
      tokensAfter: 40,
      degraded: false,
    };
    const receipt: ContextBuildReceipt = {
      contextFingerprint: "sha256:test" as never,
      mode: "NORMAL",
      modelRef: { provider: "test", model: "model" },
      policyFingerprint: "sha256:policy",
      sources: [source],
      budget: {
        contextWindowTokens: 1000,
        outputReserveTokens: 100,
        safetyReserveTokens: 10,
        requestOverheadTokens: 5,
        effectiveInputLimitTokens: 885,
        mandatoryTokens: 10,
        selectedTokens: 20,
        remainingTokens: 865,
      },
      pressure: "NORMAL",
      compaction,
      checkpoint: compaction.checkpoint,
      toolSchemaTokens: 5,
      materializedTokens: 20,
    };
    const usage: ContextUsageSnapshot = {
      runId: createRunId(),
      modelRef: { provider: "test", model: "model" },
      contextWindowTokens: 1000,
      effectiveInputLimitTokens: 885,
      estimatedInputTokens: 20,
      remainingTokens: 865,
      pressureState: "NORMAL",
      compactionCount: 1,
      breakdown: [{ sourceId: "agent.conversation", tokens: 20, itemCount: 1 }],
      lastBuildStatus: "SUCCESS",
      contextFingerprint: receipt.contextFingerprint,
      updatedAt: createTimestampMs(2),
    };
    const usageStore: ContextUsageStorePort = {
      async upsert() {},
      async getByRun() {
        return usage;
      },
    };
    const commit: ContextCompactionCommitPort = {
      async commit() {
        throw new Error("test port");
      },
    };

    expect(receipt.compaction?.checkpoint).toBe(receipt.checkpoint);
    expect(usageStore).toBeDefined();
    expect(commit).toBeDefined();
  });
});
