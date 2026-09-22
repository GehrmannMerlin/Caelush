import { afterEach, describe, expect, it } from "vitest";
import { createStepId, createTimestampMs } from "@caelush/protocol";
import type { RunId, SessionId } from "@caelush/protocol";
import {
  AgentMessageCodecError,
  createAgentConversationRepository,
  createAgentMessageFactory,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  deriveLegacyAgentMessageId,
} from "@caelush/agent";
import type { AgentMessage, AgentMessageRecord, AgentMessageRecordDraft } from "@caelush/agent";
import {
  AmbiguousObservationError,
  LegacyMessageParseError,
  backfillLegacyAgentMessages,
  openCaelushStorage,
  readRowAsRecord,
} from "../src/index.js";
import type { CaelushStorage } from "../src/index.js";
import type { LegacyAndV2MessageRow, LegacyMessageParser } from "../src/index.js";
import { makeRun, makeSession, makeStep } from "./support/fixtures.js";

/**
 * Phase 5B — the SQLite Message V2 record store, the dual reader and the deterministic backfill.
 *
 * The legacy parser is supplied by the **test**, not by the package. Parsing the pre-V2 language is the
 * dependency `@caelush/storage` must not take a second time, so the composition root owns it; injecting a
 * structural parser here exercises exactly the seam the real one uses.
 */

/**
 * A structural legacy parser over an in-memory database that the test controls.
 *
 * It validates the minimal shape the converter reads and throws {@link LegacyMessageParseError} for
 * anything else, which is what an injected parser must honour so a malformed row is a row-level failure
 * rather than an infrastructure abort.
 */
const parseLegacy: LegacyMessageParser = (raw) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LegacyMessageParseError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new LegacyMessageParseError();
  const candidate = parsed as Record<string, unknown>;
  const role = candidate["role"];
  if (role === "system" && typeof candidate["content"] === "string") {
    return { role: "system", content: candidate["content"] };
  }
  if (role === "user" && typeof candidate["content"] === "string") {
    return { role: "user", content: candidate["content"] };
  }
  if (role === "assistant" && Array.isArray(candidate["content"])) {
    return { role: "assistant", content: candidate["content"] as never };
  }
  if (
    role === "tool" &&
    typeof candidate["toolCallId"] === "string" &&
    typeof candidate["toolName"] === "string" &&
    typeof candidate["content"] === "string" &&
    typeof candidate["isError"] === "boolean"
  ) {
    return {
      role: "tool",
      toolCallId: candidate["toolCallId"],
      toolName: candidate["toolName"],
      content: candidate["content"],
      isError: candidate["isError"],
    };
  }
  throw new LegacyMessageParseError();
};

const turns = createDeterministicConversationTurnIdFactory();
const projectors = createStandardAgentMessageProjectorRegistry();
const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));

/** A message factory over scripted ids and a fixed clock. */
function messageFactory(count = 64) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(`amsg_0192f5b1-4d3a-7c2e-8a91-${index.toString(16).padStart(12, "0")}`);
  }
  let cursor = 0;
  return createAgentMessageFactory({
    ids: { create: () => ids[cursor++] as never },
    now: () => createTimestampMs(1_700_000_000_000),
    turns,
  });
}

/**
 * A record draft from a message.
 *
/**
 * A capturing in-memory record store.
 *
 * The tests need the *record drafts* the canonical repository produces, because that is the shape the
 * SQLite store accepts and hand-building one would be a second encoder. This store captures them while
 * giving the repository a working implementation, so the conversion under test is the real one.
 */
class CapturingStore {
  readonly captured: AgentMessageRecordDraft[] = [];
  readonly #byRun = new Map<string, AgentMessageRecord[]>();

  async append(
    runId: RunId,
    drafts: readonly AgentMessageRecordDraft[],
  ): Promise<readonly AgentMessageRecord[]> {
    const existing = this.#byRun.get(runId) ?? [];
    const next = existing.length + 1;
    const appended = drafts.map((draft, index) => ({
      ...draft,
      runId,
      sequence: next + index,
    })) as AgentMessageRecord[];
    this.#byRun.set(runId, [...existing, ...appended]);
    this.captured.push(...drafts);
    return appended;
  }

  async listByRun(runId: RunId): Promise<readonly AgentMessageRecord[]> {
    return [...(this.#byRun.get(runId) ?? [])];
  }

  async listBySession(): Promise<readonly AgentMessageRecord[]> {
    return [...this.#byRun.values()].flat();
  }

  /** The most recent record draft, which is the one a test just produced. */
  get latest(): AgentMessageRecordDraft {
    const draft = this.captured[this.captured.length - 1];
    if (draft === undefined) throw new Error("no record draft was produced");
    return draft;
  }
}

/** The canonical repository over a capturing store, plus the capture itself. */
function capturingRepository(sessionId: SessionId) {
  const store = new CapturingStore();
  const repository = createAgentConversationRepository({
    codecs,
    store,
    turns,
    runMetadata: {
      read: async (runId) => ({
        runId,
        sessionId,
        createdAt: 1_700_000_000_000 as never,
        terminal: false,
      }),
    },
    validator: { validate: () => undefined },
  });
  return { store, repository };
}

/** Convert one message into the record draft the SQLite store accepts. */
async function recordDraftOf(
  runId: RunId,
  sessionId: SessionId,
  message: AgentMessage,
): Promise<AgentMessageRecordDraft> {
  const { store, repository } = capturingRepository(sessionId);
  await repository.append(runId, [codecs.encode(message)]);
  return store.latest;
}

/**
 * One migrated in-memory database, with a real Session, Run and (optionally) a Step.
 *
 * The client is opened and migrated directly rather than through the storage facade, because the tests
 * need raw SQL for the two things the facade deliberately does not expose: seeding legacy-only rows, and
 * running the one-shot data migration.
 */
async function openSeeded(options: { readonly step?: boolean; readonly status?: string } = {}) {
  /*
   * `:memory:` is per-connection, so the client used for raw SQL must be the same connection the facade
   * holds. The facade therefore exposes no client and the test borrows the one the store was built on.
   */
  const storage = await openCaelushStorage({ path: ":memory:" });
  const db = storage.messageRecords.database;
  const session = makeSession();
  const run = makeRun(session.id, {
    status: (options.status ?? "RUNNING") as never,
  });
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  let stepId: string | undefined;
  if (options.step === true) {
    const step = makeStep(run.id);
    await storage.steps.insert(step);
    stepId = step.id;
  }
  return { storage, session, run, stepId, db };
}

/** Insert a legacy-only message row directly, bypassing the V2 store. */
function insertLegacyRow(
  db: CaelushStorage["messageRecords"]["database"],
  input: {
    readonly runId: RunId;
    readonly sequence: number;
    readonly role: string;
    readonly payload: unknown;
    readonly sourceStepId?: string | undefined;
    readonly createdAt?: number | undefined;
  },
): void {
  db.client
    .prepare(
      `INSERT INTO agent_messages
         (run_id, sequence, role, source_step_id, protocol_version, created_at_ms, data_json)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      input.runId,
      input.sequence,
      input.role,
      input.sourceStepId ?? null,
      input.createdAt ?? 1_700_000_000_000,
      JSON.stringify(input.payload),
    );
}

function legacyRow(options: Partial<LegacyAndV2MessageRow> = {}): LegacyAndV2MessageRow {
  return {
    run_id: "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9a",
    sequence: 1,
    role: "user",
    source_step_id: null,
    created_at_ms: 1_700_000_000_000,
    data_json: JSON.stringify({ role: "user", content: "legacy" }),
    message_id: null,
    session_id: null,
    conversation_turn_id: null,
    message_type: null,
    schema_version: null,
    model_projection_version: null,
    source_json: null,
    audience_json: null,
    v2_data_json: null,
    ...options,
  };
}

afterEach(() => {
  /* Every storage in this suite is `:memory:`, so there is nothing to clean up on disk. */
});

/* ------------------------------------------------------------------------- record store */

describe("Phase 5B record store — append and read", () => {
  it("assigns a contiguous sequence starting at 1 and continues it", async () => {
    const { storage, session, run } = await openSeeded();
    const store = storage.messageRecords;
    const factory = messageFactory();
    const user = (text: string, origin: "GOAL" | "FOLLOW_UP") =>
      factory.createUser({
        runId: run.id,
        sessionId: session.id,
        conversationTurnId: turns.forRun(run.id),
        source: { kind: "USER", origin },
        content: [{ type: "TEXT", text }],
      });

    const first = await store.append(run.id, [
      await recordDraftOf(run.id, session.id, user("first", "GOAL")),
    ]);
    expect(first.map((record) => record.sequence)).toEqual([1]);

    const rest = await store.append(run.id, [
      await recordDraftOf(run.id, session.id, user("second", "FOLLOW_UP")),
      await recordDraftOf(run.id, session.id, user("third", "FOLLOW_UP")),
    ]);
    expect(rest.map((record) => record.sequence)).toEqual([2, 3]);
    await storage.close();
  });

  it("returns V2 records from listByRun and listBySession", async () => {
    const { storage, session, run } = await openSeeded();
    const store = storage.messageRecords;
    const factory = messageFactory();
    await store.append(run.id, [
      await recordDraftOf(
        run.id,
        session.id,
        factory.createUser({
          runId: run.id,
          sessionId: session.id,
          conversationTurnId: turns.forRun(run.id),
          source: { kind: "USER", origin: "GOAL" },
          content: [{ type: "TEXT", text: "hello" }],
        }),
      ),
    ]);

    const byRun = await store.listByRun(run.id);
    expect(byRun).toHaveLength(1);
    expect(byRun[0]?.messageType).toBe("USER");
    // The payload is the codec's encoding, and the envelope is not duplicated inside it.
    expect(byRun[0]?.data).toEqual({ content: [{ type: "TEXT", text: "hello" }] });

    const bySession = await store.listBySession(session.id);
    expect(bySession).toHaveLength(1);
    expect(bySession[0]?.messageId).toBe(byRun[0]?.messageId);
    await storage.close();
  });

  it("does not present a legacy-only row as a V2 record", async () => {
    const { storage, run, db } = await openSeeded();
    insertLegacyRow(db, {
      runId: run.id,
      sequence: 1,
      role: "user",
      payload: { role: "user", content: "legacy" },
    });
    const store = storage.messageRecords;
    expect(await store.listByRun(run.id)).toEqual([]);
    await storage.close();
  });

  it("returns an empty result for an empty batch", async () => {
    const { storage, run } = await openSeeded();
    const store = storage.messageRecords;
    expect(await store.append(run.id, [])).toEqual([]);
    await storage.close();
  });
});

describe("Phase 5B record store — identity and structural validation", () => {
  it("refuses a draft whose session disagrees with the owning Run", async () => {
    const { storage, session, run } = await openSeeded();
    const store = storage.messageRecords;
    const factory = messageFactory();
    const foreign = makeSession();
    const message = factory.createUser({
      runId: run.id,
      sessionId: foreign.id,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "wrong session" }],
    });
    await expect(
      store.append(run.id, [await recordDraftOf(run.id, session.id, message)]),
    ).rejects.toThrow();
    expect(await store.listByRun(run.id)).toEqual([]);
    await storage.close();
  });

  it("refuses a source step that does not exist or belongs to another Run", async () => {
    const { storage, session, run } = await openSeeded({ step: true });
    const store = storage.messageRecords;
    const factory = messageFactory();
    const message = factory.createUser({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId: turns.forRun(run.id),
      sourceStepId: createStepId(),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "unknown step" }],
    });
    await expect(
      store.append(run.id, [await recordDraftOf(run.id, session.id, message)]),
    ).rejects.toThrow();
    await storage.close();
  });

  it("refuses a batch that repeats one message id", async () => {
    const { storage, session, run } = await openSeeded();
    const store = storage.messageRecords;
    const factory = messageFactory();
    const message = factory.createUser({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "duplicate" }],
    });
    const draft = await recordDraftOf(run.id, session.id, message);
    await expect(store.append(run.id, [draft, draft])).rejects.toThrow();
    expect(await store.listByRun(run.id)).toEqual([]);
    await storage.close();
  });

  it("refuses a model-visible record with no projection version", async () => {
    // The storage boundary defends structurally even though the codec registry already guarantees it.
    const { storage, session, run } = await openSeeded();
    const store = storage.messageRecords;
    const factory = messageFactory();
    const message = factory.createUser({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "x" }],
    });
    const draft = { ...(await recordDraftOf(run.id, session.id, message)) } as Record<
      string,
      unknown
    >;
    delete draft["modelProjectionVersion"];
    await expect(store.append(run.id, [draft as never])).rejects.toThrow();
    expect(await store.listByRun(run.id)).toEqual([]);
    await storage.close();
  });

  it("accepts a model-invisible record with no projection version", async () => {
    // A message the model never sees has no model view, so recording a projector version would claim a
    // projection that never happens.
    const { storage, session, run } = await openSeeded();
    const store = storage.messageRecords;
    const factory = messageFactory();
    const visible = factory.createUser({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "hidden" }],
    });
    const hidden: AgentMessage = { ...visible, audience: { ...visible.audience, model: false } };
    const draft = codecs.encode(hidden);
    expect(draft.modelProjectionVersion).toBeUndefined();
    const appended = await store.append(run.id, [await recordDraftOf(run.id, session.id, hidden)]);
    expect(appended[0]?.modelProjectionVersion).toBeUndefined();
    await storage.close();
  });

  it("refuses an invalid schema version", async () => {
    const { storage, session, run } = await openSeeded();
    const store = storage.messageRecords;
    const factory = messageFactory();
    const message = factory.createUser({
      runId: run.id,
      sessionId: run.sessionId,
      conversationTurnId: turns.forRun(run.id),
      source: { kind: "USER", origin: "GOAL" },
      content: [{ type: "TEXT", text: "x" }],
    });
    await expect(
      store.append(run.id, [
        { ...(await recordDraftOf(run.id, session.id, message)), schemaVersion: 0 },
      ]),
    ).rejects.toThrow();
    await storage.close();
  });
});

describe("Phase 5B record store — atomicity", () => {
  it("rolls the whole batch back and consumes no sequence", async () => {
    const { storage, session, run } = await openSeeded();
    const store = storage.messageRecords;
    const factory = messageFactory();
    const good = async (text: string) =>
      await recordDraftOf(
        run.id,
        session.id,
        factory.createUser({
          runId: run.id,
          sessionId: session.id,
          conversationTurnId: turns.forRun(run.id),
          source: { kind: "USER", origin: "GOAL" },
          content: [{ type: "TEXT", text }],
        }),
      );
    const foreignSession = makeSession();
    const bad = await recordDraftOf(
      run.id,
      session.id,
      factory.createUser({
        runId: run.id,
        sessionId: foreignSession.id,
        conversationTurnId: turns.forRun(run.id),
        source: { kind: "USER", origin: "GOAL" },
        content: [{ type: "TEXT", text: "bad" }],
      }),
    );

    await store.append(run.id, [await good("a")]);
    // The batch is [good, bad]. The second row must roll the first one back too.
    await expect(store.append(run.id, [await good("b"), bad])).rejects.toThrow();

    const records = await store.listByRun(run.id);
    expect(records).toHaveLength(1);
    expect(records[0]?.sequence).toBe(1);

    // The failed batch consumed no durable sequence: the next append continues from 2.
    const next = await store.append(run.id, [await good("c")]);
    expect(next[0]?.sequence).toBe(2);
    await storage.close();
  });

  it("keeps the transaction-neutral helper free of BEGIN and COMMIT", async () => {
    // Phase 5C composes this helper into the Run commit's own transaction, so it must not open or close
    // one. Asserted against the source, because a nested transaction is not representable at runtime.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("packages/storage/src/messages/sqlite-agent-message-record-store.ts", "utf8"),
    );
    const helper = source.slice(
      source.indexOf("export function appendAgentMessageRecordsInTransaction"),
      source.indexOf("const EMPTY_LEGACY_PAYLOAD"),
    );
    expect(helper).not.toContain('exec("BEGIN');
    expect(helper).not.toContain('exec("COMMIT');
    expect(helper).not.toContain('exec("ROLLBACK');

    // And the public append does own one.
    const publicAppend = source.slice(
      source.indexOf("async append("),
      source.indexOf("async listByRun("),
    );
    expect(publicAppend).toContain('exec("BEGIN IMMEDIATE")');
    expect(publicAppend).toContain('exec("COMMIT")');
    expect(publicAppend).toContain('exec("ROLLBACK")');
  });
});

/* ------------------------------------------------------------------------- legacy backfill */

describe("Phase 5B backfill — deterministic legacy migration", () => {
  it("migrates user, assistant and tool rows, and is idempotent", async () => {
    const { storage, run, stepId, db } = await openSeeded({ step: true, status: "COMPLETED" });
    insertLegacyRow(db, {
      runId: run.id,
      sequence: 1,
      role: "user",
      payload: { role: "user", content: "please migrate" },
    });
    insertLegacyRow(db, {
      runId: run.id,
      sequence: 2,
      role: "assistant",
      sourceStepId: stepId,
      createdAt: 1_700_000_000_001,
      payload: {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read_file", input: { path: "a" } },
        ],
      },
    });
    insertLegacyRow(db, {
      runId: run.id,
      sequence: 3,
      role: "tool",
      sourceStepId: stepId,
      createdAt: 1_700_000_000_002,
      payload: {
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "file contents",
        isError: false,
      },
    });

    const first = backfillLegacyAgentMessages(db, { parse: parseLegacy });
    expect(first).toMatchObject({
      scanned: 3,
      migrated: 3,
      alreadyMigrated: 0,
      unsupported: 0,
      failed: 0,
    });

    const store = storage.messageRecords;
    const records = await store.listByRun(run.id);
    expect(records).toHaveLength(3);

    // Identity is deterministic from (runId, sequence).
    expect(records.map((record) => record.messageId)).toEqual([
      deriveLegacyAgentMessageId(run.id, 1),
      deriveLegacyAgentMessageId(run.id, 2),
      deriveLegacyAgentMessageId(run.id, 3),
    ]);
    // Provenance is LEGACY, and nothing is promoted to a stronger claim.
    expect(records[0]?.source).toEqual({ kind: "LEGACY", legacyRole: "user" });
    expect(records[1]?.source).toEqual({ kind: "LEGACY", legacyRole: "assistant" });
    expect((records[1]?.data as { model: { kind: string } }).model.kind).toBe("LEGACY_MODEL_TURN");
    // Assistant part order, identity and input survive exactly.
    expect((records[1]?.data as { content: unknown[] }).content).toEqual([
      { type: "TEXT", text: "looking" },
      { type: "TOOL_CALL", toolCallId: "call_1", toolName: "read_file", input: { path: "a" } },
    ]);
    // The Tool row carries the exact content, an unknown historical policy and no invented observation.
    const toolData = records[2]?.data as {
      projectedContent: string;
      projection: { policy: { kind: string } };
      observation: { kind: string };
    };
    expect(toolData.projectedContent).toBe("file contents");
    expect(toolData.projection.policy.kind).toBe("LEGACY_UNKNOWN");
    expect(toolData.observation.kind).toBe("NO_OBSERVATION");

    // A second run changes nothing.
    const second = backfillLegacyAgentMessages(db, { parse: parseLegacy });
    expect(second).toMatchObject({ migrated: 0, alreadyMigrated: 3 });
    expect(await store.listByRun(run.id)).toEqual(records);

    // The legacy surface is untouched: the current production reader still needs all of it.
    const rows = db.client
      .prepare(
        "SELECT role, protocol_version, data_json, source_step_id FROM agent_messages ORDER BY sequence",
      )
      .all() as Array<{
      role: string;
      protocol_version: number;
      data_json: string;
      source_step_id: string | null;
    }>;
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "tool"]);
    expect(rows.every((row) => row.protocol_version === 1)).toBe(true);
    expect(JSON.parse(rows[0]?.data_json ?? "{}")).toEqual({
      role: "user",
      content: "please migrate",
    });
    expect(rows[1]?.source_step_id).toBe(stepId);
    await storage.close();
  });

  it("recovers an observation only when exactly one is provable", async () => {
    const { storage, run, stepId, db } = await openSeeded({ step: true, status: "COMPLETED" });
    const observationId = "obs_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9d";
    const invocationId = "tinv_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9e";
    db.client
      .prepare(
        `INSERT INTO tool_invocations
           (id, run_id, step_id, external_call_id, tool_name, status, risk_level, revision,
            protocol_version, created_at_ms, data_json)
         VALUES (?, ?, ?, 'call_1', 'read_file', 'COMPLETED', 'LOW', 1, 1, 1700000000000, '{}')`,
      )
      .run(invocationId, run.id, stepId as string);
    db.client
      .prepare(
        `INSERT INTO agent_observations
           (id, run_id, step_id, kind, tool_invocation_id, protocol_version, is_error,
            created_at_ms, data_json)
         VALUES (?, ?, ?, 'TOOL', ?, 1, 0, 1700000000000, '{}')`,
      )
      .run(observationId, run.id, stepId as string, invocationId);
    insertLegacyRow(db, {
      runId: run.id,
      sequence: 1,
      role: "tool",
      sourceStepId: stepId,
      payload: {
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "observed output",
        isError: false,
      },
    });

    const report = backfillLegacyAgentMessages(db, { parse: parseLegacy });
    expect(report.migrated).toBe(1);

    const records = await storage.messageRecords.listByRun(run.id);
    expect((records[0]?.data as { observation: unknown }).observation).toEqual({
      kind: "OBSERVATION",
      observationId,
    });
    // The policy is still unknown even though the observation was recovered: they are different facts.
    expect(
      (records[0]?.data as { projection: { policy: { kind: string } } }).projection.policy.kind,
    ).toBe("LEGACY_UNKNOWN");
    await storage.close();
  });

  it("fails a row closed when the observation linkage is ambiguous", async () => {
    // Ambiguous evidence is not evidence of absence, so the row is refused rather than downgraded to
    // NO_OBSERVATION.
    const { storage, run, stepId, db } = await openSeeded({ step: true, status: "COMPLETED" });
    insertLegacyRow(db, {
      runId: run.id,
      sequence: 1,
      role: "tool",
      sourceStepId: stepId,
      payload: {
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: "x",
        isError: false,
      },
    });

    // An injected resolver that finds two candidates reports it with the exported error, which is the
    // contract that keeps "ambiguous" distinct from "none".
    const report = backfillLegacyAgentMessages(db, {
      parse: parseLegacy,
      observationIdFor: () => {
        throw new AmbiguousObservationError();
      },
    });
    expect(report.failed).toBe(1);
    expect(report.migrated).toBe(0);
    expect(report.reasons[0]?.reason).toBe("AMBIGUOUS_OBSERVATION_LINKAGE");
    // The row is untouched: ambiguous evidence is refused, never downgraded and never deleted.
    const untouched = db.client
      .prepare("SELECT v2_data_json FROM agent_messages WHERE sequence = 1")
      .get() as { v2_data_json: string | null };
    expect(untouched.v2_data_json).toBeNull();
    await storage.close();
  }, 20000);

  it("reports a system row as unsupported instead of dropping it", async () => {
    const { storage, run, db } = await openSeeded({ status: "COMPLETED" });
    insertLegacyRow(db, {
      runId: run.id,
      sequence: 1,
      role: "system",
      payload: { role: "system", content: "you are caelush" },
    });

    const report = backfillLegacyAgentMessages(db, { parse: parseLegacy });
    expect(report).toMatchObject({ unsupported: 1, migrated: 0, failed: 0 });
    expect(report.reasons[0]?.reason).toBe("SYSTEM_LEGACY_ROLE");

    // The row is still there, unmodified, because the Message Domain has no system arm.
    const row = db.client.prepare("SELECT data_json, v2_data_json FROM agent_messages").get() as {
      data_json: string;
      v2_data_json: string | null;
    };
    expect(row.v2_data_json).toBeNull();
    expect(JSON.parse(row.data_json)).toEqual({ role: "system", content: "you are caelush" });
    await storage.close();
  });

  it("reports a malformed payload as a row failure and continues the sweep", async () => {
    const { storage, run, db } = await openSeeded({ status: "COMPLETED" });
    insertLegacyRow(db, { runId: run.id, sequence: 1, role: "user", payload: "not json" });
    db.client
      .prepare(
        `INSERT INTO agent_messages (run_id, sequence, role, protocol_version, created_at_ms, data_json)
         VALUES (?, 2, 'user', 1, 1700000000000, ?)`,
      )
      .run(run.id, "not json at all");
    db.client
      .prepare(
        `INSERT INTO agent_messages (run_id, sequence, role, protocol_version, created_at_ms, data_json)
         VALUES (?, 3, 'user', 1, 1700000000000, ?)`,
      )
      .run(run.id, JSON.stringify({ role: "user", content: "good" }));

    const report = backfillLegacyAgentMessages(db, { parse: parseLegacy });
    expect(report.scanned).toBe(3);
    expect(report.unsupported).toBe(2);
    expect(report.migrated).toBe(1);
    expect(report.reasons.every((reason) => reason.reason === "UNPARSEABLE_LEGACY_JSON")).toBe(
      true,
    );
    // One bad row did not abort the sweep.
    expect(await storage.messageRecords.listByRun(run.id)).toHaveLength(1);
    await storage.close();
  });

  it("reports a row whose owning Run is gone as failed rather than inventing a session", async () => {
    const { storage, db } = await openSeeded({ status: "COMPLETED" });
    const orphanRun = "run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9f";
    db.client.exec("PRAGMA foreign_keys = OFF");
    db.client
      .prepare(
        `INSERT INTO agent_messages (run_id, sequence, role, protocol_version, created_at_ms, data_json)
         VALUES (?, 1, 'user', 1, 1700000000000, ?)`,
      )
      .run(orphanRun, JSON.stringify({ role: "user", content: "orphan" }));
    db.client.exec("PRAGMA foreign_keys = ON");

    const report = backfillLegacyAgentMessages(db, { parse: parseLegacy });
    expect(report.failed).toBe(1);
    expect(report.reasons[0]?.reason).toBe("RUN_NOT_FOUND");
    await storage.close();
  });
});

/* ------------------------------------------------------------------------------ dual read */

describe("Phase 5B dual read — one interface over both encodings", () => {
  it("converts a legacy-only row to the record it migrates to", async () => {
    const { storage, session, run } = await openSeeded();
    const outcome = readRowAsRecord(legacyRow({ run_id: run.id }), {
      sessionId: session.id,
      parse: parseLegacy,
    });
    expect(outcome.kind).toBe("LEGACY");
    if (outcome.kind !== "LEGACY") throw new Error("unreachable");
    expect(outcome.record.messageType).toBe("USER");
    expect(outcome.record.messageId).toBe(deriveLegacyAgentMessageId(run.id, 1));
    expect(outcome.record.sessionId).toBe(session.id);
    await storage.close();
  });

  it("prefers the V2 record and never returns both", async () => {
    const { storage, session, run, stepId, db } = await openSeeded({ step: true });
    insertLegacyRow(db, {
      runId: run.id,
      sequence: 1,
      role: "user",
      payload: { role: "user", content: "legacy" },
    });
    backfillLegacyAgentMessages(db, { parse: parseLegacy, runId: run.id });

    const row = db.client
      .prepare("SELECT * FROM agent_messages WHERE run_id = ? AND sequence = 1")
      .get(run.id) as unknown as LegacyAndV2MessageRow;
    expect(row.v2_data_json).not.toBeNull();

    const outcome = readRowAsRecord(row, { sessionId: session.id, parse: parseLegacy });
    expect(outcome.kind).toBe("V2");
    if (outcome.kind !== "V2") throw new Error("unreachable");
    expect(outcome.record.messageType).toBe("USER");
    void stepId;
    await storage.close();
  });

  it("fails closed when a row's V2 type and legacy role disagree", async () => {
    // Picking whichever was read first is how a ledger ends up with two irreconcilable accounts.
    const { storage, session, run } = await openSeeded();
    expect(() =>
      readRowAsRecord(
        legacyRow({
          run_id: run.id,
          role: "user",
          message_id: "amsg_0192f5b1-4d3a-7c2e-8a91-000000000001",
          session_id: session.id,
          conversation_turn_id: turns.forRun(run.id),
          message_type: "ASSISTANT",
          schema_version: 1,
          model_projection_version: 1,
          source_json: JSON.stringify({ kind: "LEGACY", legacyRole: "user" }),
          audience_json: JSON.stringify({ model: true, transcript: true, debug: true }),
          v2_data_json: JSON.stringify({ content: [], model: { kind: "LEGACY_MODEL_TURN" } }),
        }),
        { sessionId: session.id, parse: parseLegacy },
      ),
    ).toThrow();
    await storage.close();
  });

  it("preserves an unknown V2-backed record and fails only the semantic decode", async () => {
    const { storage, run, db } = await openSeeded();
    db.client
      .prepare(
        `INSERT INTO agent_messages
           (run_id, sequence, role, protocol_version, created_at_ms, data_json,
            message_id, session_id, conversation_turn_id, message_type, schema_version,
            model_projection_version, source_json, audience_json, v2_data_json)
         VALUES (?, 1, 'plugin.future_message', 1, 1700000000000, '{}',
                 ?, ?, ?, 'plugin.future_message', 99, 1, ?, ?, ?)`,
      )
      .run(
        run.id,
        "amsg_0192f5b1-4d3a-7c2e-8a91-000000000002",
        run.sessionId,
        turns.forRun(run.id),
        JSON.stringify({ kind: "AGENT", producer: "plugin" }),
        JSON.stringify({ model: true, transcript: true, debug: true }),
        JSON.stringify({ anything: 1 }),
      );

    const store = storage.messageRecords;
    // Raw storage preserves and returns it, whatever it is.
    const records = await store.listByRun(run.id);
    expect(records).toHaveLength(1);
    expect(records[0]?.messageType).toBe("plugin.future_message");
    expect(records[0]?.schemaVersion).toBe(99);

    // The codec registry fails closed rather than falling forward to a version it does not have.
    expect(() => codecs.decode(records[0] as AgentMessageRecord)).toThrow(AgentMessageCodecError);

    // Nothing was deleted or rewritten by the read.
    expect(await store.listByRun(run.id)).toHaveLength(1);
    await storage.close();
  });
});
