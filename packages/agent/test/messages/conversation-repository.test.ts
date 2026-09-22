import { describe, expect, it } from "vitest";

import {
  AgentConversationLoadError,
  AgentMessageCodecError,
  createAgentConversationRepository,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageCodecRegistry,
  projectionVersionTable,
  AgentConversationError,
  createAgentConversationValidator,
} from "@caelush/agent";
import type {
  AgentConversationRepository,
  AgentMessageDraft,
  AgentMessageRecord,
  AgentMessageRecordDraft,
  ConversationRunMetadataReader,
  SessionReadableAgentMessageRecordStore,
  StoredAgentMessage,
} from "@caelush/agent";
import type { RunId, SessionId, TimestampMs } from "@caelush/protocol";

import {
  CREATED_AT,
  OTHER_RUN_ID,
  RUN_ID,
  SESSION_ID,
  assistantMessage,
  codecs,
  projectors,
  toolResultMessage,
  turnIdFor,
  userMessage,
} from "./fixtures.js";

/**
 * Phase 5B — the semantic conversation repository.
 *
 * ```text
 * AgentMessageDraft  →  versioned record  →  durable store
 * durable store      →  versioned record  →  StoredAgentMessage  →  snapshot
 * ```
 *
 * The tests run against an in-memory record store and an in-memory Run metadata reader, which is the
 * point: the repository composes *ports*, so it is exercisable with no database, no RunController and
 * no Runtime anywhere in sight.
 */

/* ------------------------------------------------------------------- in-memory test doubles */

/**
 * A minimal record store.
 *
 * It assigns sequence the way the contract requires — one contiguous range per batch — so the
 * repository is tested against a store that behaves like the real one rather than one that echoes
 * whatever it was handed.
 */
class RecordingStore implements SessionReadableAgentMessageRecordStore {
  readonly #byRun = new Map<string, AgentMessageRecord[]>();
  /** Fails the next append after this many rows have been accepted, to exercise partial batches. */
  failAfterRows: number | undefined;

  async append(
    runId: RunId,
    records: readonly AgentMessageRecordDraft[],
  ): Promise<readonly AgentMessageRecord[]> {
    const existing = this.#byRun.get(runId) ?? [];
    const next = existing.length + 1;
    const appended: AgentMessageRecord[] = [];
    for (const [index, draft] of records.entries()) {
      if (this.failAfterRows !== undefined && index >= this.failAfterRows) {
        throw new Error("simulated store failure");
      }
      appended.push({
        ...draft,
        runId,
        sequence: next + index,
      } as AgentMessageRecord);
    }
    this.#byRun.set(runId, [...existing, ...appended]);
    return appended;
  }

  async listByRun(runId: RunId): Promise<readonly AgentMessageRecord[]> {
    return [...(this.#byRun.get(runId) ?? [])];
  }

  async listBySession(sessionId: SessionId): Promise<readonly AgentMessageRecord[]> {
    const all = [...this.#byRun.values()].flat();
    return all.filter((record) => record.sessionId === sessionId);
  }

  /** Seed a raw record directly, for cases the repository cannot itself produce. */
  seed(record: AgentMessageRecord): void {
    const bucket = this.#byRun.get(record.runId) ?? [];
    bucket.push(record);
    this.#byRun.set(record.runId, bucket);
  }
}

/** A metadata reader over a fixed table. */
class FixedRunMetadata implements ConversationRunMetadataReader {
  constructor(
    private readonly runs: ReadonlyMap<
      string,
      {
        runId: RunId;
        sessionId: SessionId;
        createdAt: TimestampMs;
        finishedAt?: TimestampMs;
        terminal: boolean;
      }
    >,
  ) {}

  async read(runId: RunId) {
    return this.runs.get(runId);
  }
}

function runMetadata(
  entries: readonly {
    runId: string;
    sessionId?: string;
    createdAt: number;
    finishedAt?: number;
    terminal: boolean;
  }[],
) {
  return new FixedRunMetadata(
    new Map(
      entries.map((entry) => [
        entry.runId,
        {
          runId: entry.runId as RunId,
          sessionId: (entry.sessionId ?? SESSION_ID) as SessionId,
          createdAt: entry.createdAt as TimestampMs,
          ...(entry.finishedAt === undefined
            ? {}
            : { finishedAt: entry.finishedAt as TimestampMs }),
          terminal: entry.terminal,
        },
      ]),
    ),
  );
}

function repository(
  store: RecordingStore,
  metadata: ConversationRunMetadataReader,
): AgentConversationRepository {
  return createAgentConversationRepository({
    codecs,
    store,
    turns: createDeterministicConversationTurnIdFactory(),
    runMetadata: metadata,
    validator: createAgentConversationValidator(),
  });
}

/**
 * A draft for one already-created message, produced the way a real caller must produce one.
 *
 * It goes through the codec registry, because that is the only thing that can turn a semantic message
 * into the versioned payload a record carries. Hand-building a draft would be a second encoder.
 */
function draftOf(
  message: StoredAgentMessage["message"],
  modelProjectionVersion = 1,
): AgentMessageDraft {
  const draft = codecs.encode(message);
  return { ...draft, modelProjectionVersion };
}

/* ------------------------------------------------------------------------------------ append */

describe("Phase 5B repository — append", () => {
  it("encodes, persists and returns stored messages with assigned sequence", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));

    const user = userMessage({ sequence: 0 }).message;
    const assistant = assistantMessage({ text: "hi", sequence: 0 }).message;

    const stored = await repo.append(RUN_ID as never, [draftOf(user), draftOf(assistant)]);

    expect(stored).toHaveLength(2);
    expect(stored.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(stored[0]?.message).toEqual(user);
    expect(stored[1]?.message).toEqual(assistant);
    expect(stored[0]?.schemaVersion).toBe(1);
    // The projection version the draft carried is preserved on the record.
    expect(stored[0]?.modelProjectionVersion).toBe(1);
  });

  it("stores an encoded payload rather than the semantic message", async () => {
    // The store must receive the codec's JSON payload, not a semantic message object: a durable row is
    // bytes. This is asserted through a round trip rather than by inspecting the draft's field names,
    // so the test is about the durable shape and not about a naming convention.
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    const user = userMessage({ sequence: 0 }).message;
    await repo.append(RUN_ID as never, [draftOf(user)]);

    const raw = await store.listByRun(RUN_ID as never);
    expect(raw).toHaveLength(1);
    expect(raw[0]?.messageType).toBe("USER");
    expect(raw[0]?.messageId).toBe(user.id);

    // The payload is JSON-safe structure, not a message: no `id`, no `runId`, no `audience`, because
    // those live on the envelope.
    const payload = raw[0]?.data as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["content"]);
    expect(payload["id"]).toBeUndefined();
    expect(payload["runId"]).toBeUndefined();
    expect(payload["audience"]).toBeUndefined();

    // And the envelope plus that payload reconstruct the exact message.
    const listed = await repo.listByRun(RUN_ID as never);
    expect(listed[0]?.message).toEqual(user);
  });

  it("returns an empty result for an empty batch without touching the store", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    expect(await repo.append(RUN_ID as never, [])).toEqual([]);
    expect(await store.listByRun(RUN_ID as never)).toEqual([]);
  });

  it("refuses a draft whose message belongs to another Run", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    const foreign = userMessage({ runId: OTHER_RUN_ID, sequence: 0 }).message;
    await expect(repo.append(RUN_ID as never, [draftOf(foreign)])).rejects.toThrow(TypeError);
    expect(await store.listByRun(RUN_ID as never)).toEqual([]);
  });

  it("propagates a store failure without leaving a partial batch visible", async () => {
    const store = new RecordingStore();
    store.failAfterRows = 1;
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    await expect(
      repo.append(RUN_ID as never, [
        draftOf(userMessage({ sequence: 0 }).message),
        draftOf(assistantMessage({ text: "hi", sequence: 0 }).message),
      ]),
    ).rejects.toThrow("simulated store failure");
  });
});

/* ------------------------------------------------------------------------------ list by run */

describe("Phase 5B repository — listByRun", () => {
  it("decodes raw records with the exact stored schema version", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    const user = userMessage({ sequence: 0 }).message;
    await repo.append(RUN_ID as never, [draftOf(user)]);

    const listed = await repo.listByRun(RUN_ID as never);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.message).toEqual(user);
    expect(listed[0]?.sequence).toBe(1);
  });

  it("fails closed on a record no codec can decode, and leaves the row intact", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    store.seed({
      messageId: "amsg_0192f5b1-4d3a-7c2e-8a91-0000000000ff" as never,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      sequence: 1,
      conversationTurnId: turnIdFor(),
      messageType: "FROM_THE_FUTURE",
      schemaVersion: 1,
      createdAt: CREATED_AT as never,
      source: { kind: "AGENT", producer: "future" },
      audience: { model: true, transcript: true, debug: true },
      data: {},
    });

    await expect(repo.listByRun(RUN_ID as never)).rejects.toBeInstanceOf(AgentMessageCodecError);
    // The row is still there, unchanged: a decode failure is not a licence to delete.
    const raw = await store.listByRun(RUN_ID as never);
    expect(raw).toHaveLength(1);
    expect(raw[0]?.messageType).toBe("FROM_THE_FUTURE");
  });
});

/* ----------------------------------------------------------------------------- load snapshot */

describe("Phase 5B repository — loadSnapshot", () => {
  it("builds a single-Run snapshot with the current turn and validates it", async () => {
    const store = new RecordingStore();
    const repo = repository(
      store,
      runMetadata([{ runId: RUN_ID, createdAt: CREATED_AT, terminal: false }]),
    );
    await repo.append(RUN_ID as never, [
      draftOf(userMessage({ sequence: 0 }).message),
      draftOf(assistantMessage({ text: "hi", sequence: 0 }).message),
    ]);

    const snapshot = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });

    expect(snapshot.sessionId).toBe(SESSION_ID);
    expect(snapshot.currentRunId).toBe(RUN_ID);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.runId).toBe(RUN_ID);
    expect(snapshot.turns[0]?.messages).toHaveLength(2);
  });

  it("uses Run.createdAt for openedAt, never the first message's timestamp", async () => {
    // The two are deliberately different here, so a reader that used the message would fail.
    const runCreatedAt = 1_600_000_000_000;
    const store = new RecordingStore();
    const repo = repository(
      store,
      runMetadata([{ runId: RUN_ID, createdAt: runCreatedAt, terminal: false }]),
    );
    await repo.append(RUN_ID as never, [draftOf(userMessage({ sequence: 0 }).message)]);

    const snapshot = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });
    expect(snapshot.turns[0]?.openedAt).toBe(runCreatedAt);
    expect(snapshot.turns[0]?.openedAt).not.toBe(CREATED_AT);
  });

  it("marks a non-terminal Run OPEN and a terminal Run CLOSED with finishedAt", async () => {
    const store = new RecordingStore();
    const repo = repository(
      store,
      runMetadata([
        { runId: RUN_ID, createdAt: 1, terminal: false },
        { runId: OTHER_RUN_ID, createdAt: 2, finishedAt: 99, terminal: true },
      ]),
    );
    await repo.append(RUN_ID as never, [draftOf(userMessage({ sequence: 0 }).message)]);
    await repo.append(OTHER_RUN_ID as never, [
      draftOf(userMessage({ sequence: 0, runId: OTHER_RUN_ID }).message),
    ]);

    const open = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });
    const openTurn = open.turns.find((turn) => turn.runId === RUN_ID);
    expect(openTurn?.status).toBe("OPEN");
    expect(openTurn?.closedAt).toBeUndefined();

    const closed = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: OTHER_RUN_ID as never,
    });
    const closedTurn = closed.turns.find((turn) => turn.runId === OTHER_RUN_ID);
    expect(closedTurn?.status).toBe("CLOSED");
    expect(closedTurn?.closedAt).toBe(99);
  });

  it("orders turns by Run.createdAt then Run.id", async () => {
    const store = new RecordingStore();
    const later = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9f";
    const repo = repository(
      store,
      runMetadata([
        { runId: later, createdAt: 500, terminal: false },
        { runId: RUN_ID, createdAt: 100, terminal: false },
        { runId: OTHER_RUN_ID, createdAt: 500, terminal: false },
      ]),
    );
    for (const runId of [later, RUN_ID, OTHER_RUN_ID]) {
      await repo.append(runId as never, [draftOf(userMessage({ sequence: 0, runId }).message)]);
    }

    const snapshot = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });
    const order = snapshot.turns.map((turn) => turn.openedAt);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    // The two Runs sharing createdAt=500 are ordered by Run id.
    const tie = snapshot.turns.filter((turn) => turn.openedAt === 500).map((turn) => turn.runId);
    expect(tie).toEqual([...tie].sort());
  });

  it("orders messages inside a turn by their stored sequence", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    // A complete Tool exchange, so the validator accepts the loaded conversation: an unanswered
    // model-visible call is legal only as the trailing material of a turn.
    await repo.append(RUN_ID as never, [
      draftOf(userMessage({ sequence: 0 }).message),
      draftOf(assistantMessage({ toolCalls: ["call_1"], sequence: 0 }).message),
      draftOf(toolResultMessage({ toolCallId: "call_1", toolName: "tool_0" }).message),
    ]);

    const snapshot = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });
    const sequences = snapshot.turns[0]?.messages.map((entry) => entry.sequence);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it("includes the current Run as an empty turn when it has no messages yet", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    const snapshot = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.messages).toEqual([]);
  });

  it("fails closed when the current Run does not exist", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([]));
    let thrown: unknown;
    try {
      await repo.loadSnapshot({
        sessionId: SESSION_ID as never,
        currentRunId: RUN_ID as never,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentConversationLoadError);
    expect((thrown as AgentConversationLoadError).reason).toBe("CURRENT_RUN_NOT_FOUND");
  });

  it("fails closed when a stored message belongs to a Run that is gone", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    await repo.append(OTHER_RUN_ID as never, [
      draftOf(userMessage({ sequence: 0, runId: OTHER_RUN_ID }).message),
    ]);

    let thrown: unknown;
    try {
      await repo.loadSnapshot({
        sessionId: SESSION_ID as never,
        currentRunId: RUN_ID as never,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentConversationLoadError);
    expect((thrown as AgentConversationLoadError).reason).toBe("RUN_NOT_FOUND");
  });

  it("fails closed when a turn belongs to another Session", async () => {
    const otherSession = "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c";
    const store = new RecordingStore();
    const repo = repository(
      store,
      runMetadata([{ runId: RUN_ID, sessionId: otherSession, createdAt: 1, terminal: false }]),
    );
    let thrown: unknown;
    try {
      await repo.loadSnapshot({
        sessionId: SESSION_ID as never,
        currentRunId: RUN_ID as never,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentConversationLoadError);
    expect((thrown as AgentConversationLoadError).reason).toBe("RUN_SESSION_MISMATCH");
  });

  it("invokes the validator, so an invalid conversation is refused at load", async () => {
    // Two records claiming the same message id is a durable defect the validator already owns.
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    const user = userMessage({ sequence: 0 }).message;
    await repo.append(RUN_ID as never, [draftOf(user)]);
    store.seed({
      messageId: user.id,
      runId: RUN_ID as never,
      sessionId: SESSION_ID as never,
      sequence: 1,
      conversationTurnId: turnIdFor(),
      messageType: "USER",
      schemaVersion: 1,
      modelProjectionVersion: 1,
      createdAt: CREATED_AT as never,
      source: user.source,
      audience: user.audience,
      data: { content: [{ type: "TEXT", text: "hello" }] },
    });

    await expect(
      repo.loadSnapshot({ sessionId: SESSION_ID as never, currentRunId: RUN_ID as never }),
    ).rejects.toBeInstanceOf(AgentConversationError);
  });

  it("is deterministic: the same Session loads identically twice", async () => {
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 7, terminal: false }]));
    await repo.append(RUN_ID as never, [draftOf(userMessage({ sequence: 0 }).message)]);
    const first = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });
    const second = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });
    expect(second).toEqual(first);
    // The turn identity is the deterministic derivation, so it survives a process boundary.
    expect(first.currentTurnId).toBe(
      createDeterministicConversationTurnIdFactory().forRun(RUN_ID as never),
    );
  });

  it("does not project or group anything: the snapshot carries semantic messages", async () => {
    // No AI projection, no Context grouping, no transcript. The repository's job stops at decode.
    const store = new RecordingStore();
    const repo = repository(store, runMetadata([{ runId: RUN_ID, createdAt: 1, terminal: false }]));
    await repo.append(RUN_ID as never, [draftOf(userMessage({ sequence: 0 }).message)]);
    const snapshot = await repo.loadSnapshot({
      sessionId: SESSION_ID as never,
      currentRunId: RUN_ID as never,
    });
    const message = snapshot.turns[0]?.messages[0]?.message;
    expect(message?.type).toBe("USER");
    expect(message && "role" in message).toBe(false);
    // The projector registry is a separate authority and is untouched by a load.
    expect(projectors.currentVersion("USER")).toBe(1);
    expect(
      createStandardAgentMessageCodecRegistry(projectionVersionTable({ USER: 1 })).has("USER", 1),
    ).toBe(true);
  });
});
