import { describe, expect, it } from "vitest";
import { createTimestampMs, type RunId, type SessionId } from "@caelush/protocol";
import {
  createAgentConversationRepository,
  createAgentMessageFactory,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
} from "@caelush/agent";
import type { AgentMessage, AgentMessageRecordDraft } from "@caelush/agent";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const turns = createDeterministicConversationTurnIdFactory();
const projectors = createStandardAgentMessageProjectorRegistry();
const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));

function messageFactory() {
  let cursor = 0;
  return createAgentMessageFactory({
    ids: { create: () => `amsg_0192f5b1-4d3a-7c2e-8a91-${String(cursor++).padStart(12, "0")}` as never },
    now: () => createTimestampMs(1_700_000_000_000),
    turns,
  });
}

async function recordDraftOf(
  runId: RunId,
  sessionId: SessionId,
  message: AgentMessage,
): Promise<AgentMessageRecordDraft> {
  const captured: AgentMessageRecordDraft[] = [];
  const repository = createAgentConversationRepository({
    codecs,
    store: {
      append: async (_runId, drafts) => {
        captured.push(...drafts);
        return drafts.map((draft, index) => ({ ...draft, runId: _runId, sequence: index + 1 }));
      },
      listByRun: async () => [],
      listBySession: async () => [],
    },
    turns,
    runMetadata: {
      read: async (id) => ({
        runId: id,
        sessionId,
        createdAt: createTimestampMs(1_700_000_000_000),
        terminal: false,
      }),
    },
    validator: { validate: () => undefined },
  });
  await repository.append(runId, [codecs.encode(message)]);
  const draft = captured[0];
  if (draft === undefined) throw new Error("message draft was not captured");
  return draft;
}

async function openSeeded() {
  const storage = await openCaelushStorage({ path: ":memory:" });
  const session = makeSession();
  const run = makeRun(session.id, { status: "RUNNING" as never });
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  return { storage, session, run };
}

describe("Phase 5F final Message V2 record store", () => {
  it("assigns contiguous sequences and reads final records by Run and Session", async () => {
    const { storage, session, run } = await openSeeded();
    const factory = messageFactory();
    const first = factory.createUser({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "first" }],
    });
    const second = factory.createUser({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "FOLLOW_UP" },
      content: [{ type: "TEXT", text: "second" }],
    });

    expect((await storage.messageRecords.append(run.id, [await recordDraftOf(run.id, session.id, first)])).map((record) => record.sequence)).toEqual([1]);
    expect((await storage.messageRecords.append(run.id, [await recordDraftOf(run.id, session.id, second)])).map((record) => record.sequence)).toEqual([2]);
    expect((await storage.messageRecords.listByRun(run.id)).map((record) => record.sequence)).toEqual([1, 2]);
    expect(await storage.messageRecords.listBySession(session.id)).toHaveLength(2);
    await storage.close();
  });

  it("stores a registered custom message without a legacy role or shadow payload", async () => {
    const { storage, session, run } = await openSeeded();
    const messageId = "amsg_0192f5b1-4d3a-7c2e-8a91-000000000099" as never;
    await storage.messageRecords.append(run.id, [
      {
        messageId,
        sessionId: session.id,
        conversationTurnId: turns.forRun(run.id),
        messageType: "CODING_COMMAND_EXECUTION",
        schemaVersion: 1,
        modelProjectionVersion: 1,
        createdAt: createTimestampMs(1_700_000_000_003),
        source: { kind: "AGENT", producer: "coding-agent" },
        audience: { model: true, transcript: true, debug: true },
        data: { command: "pnpm test", exitCode: 0 },
      },
    ]);

    const row = storage.messageRecords.database.client
      .prepare("SELECT * FROM agent_messages WHERE message_id = ?")
      .get(messageId) as Record<string, unknown>;
    expect(row).toMatchObject({
      message_id: messageId,
      message_type: "CODING_COMMAND_EXECUTION",
      data_json: JSON.stringify({ command: "pnpm test", exitCode: 0 }),
    });
    expect(row).not.toHaveProperty("role");
    expect(row).not.toHaveProperty("protocol_version");
    expect(row).not.toHaveProperty("v2_data_json");
    await storage.close();
  });

  it("rejects a draft whose session disagrees with the owning Run", async () => {
    const { storage, session, run } = await openSeeded();
    const factory = messageFactory();
    const message = factory.createUser({
      runId: run.id,
      sessionId: session.id,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "invalid" }],
    });
    const draft = await recordDraftOf(run.id, session.id, message);
    await expect(
      storage.messageRecords.append(run.id, [{ ...draft, sessionId: "ses_other" as never }]),
    ).rejects.toThrow();
    expect(await storage.messageRecords.listByRun(run.id)).toEqual([]);
    await storage.close();
  });
});
