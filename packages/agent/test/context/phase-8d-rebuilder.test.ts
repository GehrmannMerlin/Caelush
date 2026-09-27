import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { ModelDescriptor } from "@caelush/ai";
import { createRunId } from "@caelush/protocol";
import {
  createContextCompactionRebuilder,
  createContextMessageRange,
  createContextPolicy,
  createStructuredCheckpoint,
  conversationTurnId,
  type ContextCompactionRebuildInput,
  type ContextCompactionRebuildResult,
} from "@caelush/agent";

import { snapshot } from "../messages/fixtures.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "phase-8d-rebuilder" },
  api: "fixture",
  limits: { contextWindowTokens: 10_000, maxOutputTokens: 100 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

function rebuildInput(): ContextCompactionRebuildInput {
  const runId = createRunId();
  const sourceRange = createContextMessageRange({
    runId,
    conversationTurnId: conversationTurnId("cturn_phase_8d_rebuilder"),
    firstMessageId: "amsg_phase_8d_rebuilder_first" as never,
    lastMessageId: "amsg_phase_8d_rebuilder_last" as never,
    firstSequence: 1,
    lastSequence: 2,
  });
  return {
    conversation: snapshot([], { runId: String(runId) }),
    checkpoint: createStructuredCheckpoint({
      version: 1,
      goal: "goal",
      constraints: [],
      completedWork: [],
      inProgress: [],
      blocked: [],
      importantDiscoveries: [],
      keyDecisions: [],
      changedFiles: [],
      readFiles: [],
      recentErrors: [],
      verificationState: "CURRENT",
      activeProcesses: [],
      pendingApprovals: [],
      resourceGovernance: "BOUNDED",
      criticalReferences: [],
      nextIntent: "continue",
      sourceRange: { from: 1, to: 2 },
    }),
    sourceRange,
    policy: createContextPolicy({ model: MODEL }),
    model: MODEL,
  };
}

describe("Phase 8D ContextCompactionRebuilder", () => {
  it("returns only the actual build estimate and retained durable message IDs", async () => {
    const expected: ContextCompactionRebuildResult = {
      estimatedInputTokens: 4200,
      retainedMessageIds: ["amsg_phase_8d_retained" as never],
    };
    let received: ContextCompactionRebuildInput | undefined;
    const rebuilder = createContextCompactionRebuilder({
      async build(input) {
        received = input;
        return expected;
      },
    });

    const result = await rebuilder.rebuild(rebuildInput());

    expect(result).toEqual(expected);
    expect(received?.checkpoint.sourceRange).toEqual({ from: 1, to: 2 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.retainedMessageIds)).toBe(true);
  });

  it("is an Agent-owned pure adapter with no recursive Engine or persistence authority", () => {
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/context/compaction/context-compaction-rebuilder.ts",
      ),
      "utf8",
    );

    expect(source).not.toMatch(
      /ContextEngine\.prepare|ContextSummar|ContextCompactionCommit|@caelush\/storage|usageStore|notifyCommitted/u,
    );
  });
});
