import {
  createAgentMessageCodecRegistry,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageTranscriptProjectorRegistry,
  projectionVersionTable,
} from "@caelush/agent";
import type { AgentMessageRecord } from "@caelush/agent";
import type { AgentRun, AgentSession, RunId, SessionId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

import { SessionTranscriptService } from "../src/services/session-transcript-service.js";

const sessionId = "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as SessionId;
const runId = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a" as RunId;
const session = { id: sessionId } as AgentSession;
const run = {
  id: runId,
  sessionId,
  status: "COMPLETED",
  createdAt: 1_700_000_000_000,
  finishedAt: 1_700_000_000_010,
} as AgentRun;

const common = {
  runId,
  sessionId,
  conversationTurnId: "cturn_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c" as never,
  createdAt: 1_700_000_000_001 as never,
  sourceStepId: undefined,
  source: { kind: "USER", origin: "GOAL" } as const,
  audience: { model: true, transcript: true, debug: true },
};

function record(
  sequence: number,
  type: string,
  messageId: string,
  data: Record<string, unknown>,
  audience = common.audience,
): AgentMessageRecord {
  return {
    messageId: messageId as never,
    runId,
    sessionId,
    sequence,
    conversationTurnId: common.conversationTurnId,
    messageType: type,
    schemaVersion: 1,
    modelProjectionVersion: type === "FUTURE" ? 1 : undefined,
    createdAt: common.createdAt,
    source: common.source,
    audience,
    data,
  };
}

function makeService(records: readonly AgentMessageRecord[]) {
  return new SessionTranscriptService({
    sessions: { get: async () => session },
    runs: { listBySession: async () => [run] },
    messageRecords: { listBySession: async () => records },
    codecs: createStandardAgentMessageCodecRegistry(
      projectionVersionTable({
        USER: 1,
        ASSISTANT: 1,
        TOOL_RESULT: 1,
      }),
    ),
    transcriptProjectors: createStandardAgentMessageTranscriptProjectorRegistry(),
  });
}

describe("Phase 5E Session Transcript Service", () => {
  it("orders records by Run then sequence, skips non-transcript Tool results, and appends a terminal", async () => {
    const service = makeService([
      record(1, "USER", "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001", {
        content: [{ type: "TEXT", text: "hello" }],
      }),
      record(
        2,
        "ASSISTANT",
        "amsg_0192f5b1-4d3a-7c2e-8a91-000000000002",
        {
          content: [{ type: "TEXT", text: "answer" }],
          model: {
            kind: "MODEL_TURN",
            callId: "llm_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9d",
            model: { provider: "fixture", model: "fixture" },
            finishReason: "STOP",
          },
        },
        { model: true, transcript: true, debug: true },
      ),
      record(
        3,
        "TOOL_RESULT",
        "amsg_0192f5b1-4d3a-7c2e-8a91-000000000003",
        {
          toolCallId: "call_1",
          toolName: "read_file",
          observation: { kind: "NO_OBSERVATION" },
          isError: false,
          projectedContent: "secret output",
          projection: { policy: { kind: "LEGACY_UNKNOWN" }, fingerprint: "x", version: 1 },
        },
        { model: true, transcript: false, debug: true },
      ),
    ]);

    const response = await service.getTranscript(sessionId, { limit: 10 });
    expect(response.items.map((entry) => entry.kind)).toEqual(["USER", "ASSISTANT"]);
    expect(response.items.some((entry) => entry.kind === "RUN_TERMINAL")).toBe(false);
  });

  it("synthesizes a completed terminal fallback only when no assistant transcript exists", async () => {
    const service = makeService([
      record(1, "USER", "amsg_0192f5b1-4d3a-7c2e-8a91-000000000005", {
        content: [{ type: "TEXT", text: "missing answer" }],
      }),
    ]);

    const response = await service.getTranscript(sessionId, { limit: 10 });
    expect(response.items.map((entry) => entry.kind)).toEqual(["USER", "RUN_TERMINAL"]);
    expect(response.items[1]).toMatchObject({
      id: `${runId}:transcript:terminal`,
      status: "COMPLETED",
      text: "Run completed without a verified final result.",
    });
  });

  it("degrades unknown transcript-visible historical records without exposing their payload", async () => {
    const service = makeService([
      record(
        1,
        "FUTURE_MESSAGE",
        "amsg_0192f5b1-4d3a-7c2e-8a91-000000000004",
        { secret: "do not expose" },
        { model: false, transcript: true, debug: true },
      ),
    ]);

    const response = await service.getTranscript(sessionId, { limit: 10 });
    expect(response.items[0]).toMatchObject({
      kind: "CUSTOM",
      presentationType: "UNSUPPORTED_HISTORICAL_MESSAGE",
      text: "Unsupported historical message",
    });
    expect(JSON.stringify(response)).not.toContain("do not expose");
  });

  it("returns a typed missing-session failure rather than an empty transcript", async () => {
    const service = new SessionTranscriptService({
      sessions: { get: async () => null },
      runs: { listBySession: async () => [] },
      messageRecords: { listBySession: async () => [] },
      codecs: createAgentMessageCodecRegistry({ codecs: [] }),
      transcriptProjectors: createStandardAgentMessageTranscriptProjectorRegistry(),
    });

    await expect(service.getTranscript(sessionId, { limit: 10 })).rejects.toMatchObject({
      name: "StorageNotFoundError",
    });
  });
});
