import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createPrivateReplayReference, createAgentMessageIdFactory } from "@caelush/agent";
import type { AgentMessageRecordDraft, PrivateReplayIdentity } from "@caelush/agent";
import { createReplayProtection, createInjectedReplayKeyProvider } from "@caelush/security";
import { openCaelushStorage } from "../src/index.js";
import type { CaelushStorage } from "../src/index.js";
import { makeRun, makeSession } from "./support/fixtures.js";

const stores: CaelushStorage[] = [];
const directories: string[] = [];
const auditDatabases: DatabaseSync[] = [];
const bytes = () => Buffer.from("C3_PRIVATE_REASONING_SENTINEL");
async function expectReplayReadDenied(read: Promise<Uint8Array>): Promise<void> {
  const denied = await read.then(
    (plaintext) => {
      plaintext.fill(0);
      return false;
    },
    (error: unknown) => error instanceof Error && error.message === "Private replay unavailable.",
  );
  expect(denied).toBe(true);
}

afterEach(async () => {
  for (const database of auditDatabases.splice(0)) database.close();
  for (const store of stores.splice(0)) await store.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const protection = (key: Uint8Array) =>
  createReplayProtection(createInjectedReplayKeyProvider("fixture", key));

async function setup(path = ":memory:", key = randomBytes(32)) {
  const store = await openCaelushStorage({ path, replayProtection: protection(key) });
  stores.push(store);
  const session = makeSession();
  const run = makeRun(session.id);
  await store.sessions.insert(session);
  await store.runs.insert(run);
  const identity: PrivateReplayIdentity = {
    sessionId: session.id,
    runId: run.id,
    messageId: createAgentMessageIdFactory().create(),
    callId: "call",
    providerId: "test",
    model: "test-model",
    api: "fixture",
    replayVersion: 1,
  };
  const draft: AgentMessageRecordDraft = {
    messageId: identity.messageId as AgentMessageRecordDraft["messageId"],
    sessionId: session.id,
    conversationTurnId: `turn:${run.id}` as AgentMessageRecordDraft["conversationTurnId"],
    messageType: "ASSISTANT",
    schemaVersion: 2,
    modelProjectionVersion: 1,
    createdAt: session.createdAt,
    source: { kind: "MODEL", callId: "call" },
    audience: { model: true, transcript: true },
    data: {
      content: [{ type: "TEXT", text: "safe" }],
      phase: "FINAL_ANSWER",
      model: {
        kind: "MODEL_TURN",
        callId: "call",
        model: { provider: "test", model: "test-model" },
        finishReason: "STOP",
      },
      providerState: createPrivateReplayReference(identity),
    },
  };
  const write = await store.privateReplay.prepare(identity, bytes());
  const command = {
    run,
    expectedStateRevision: null,
    expectedContinuationRevision: null,
    stepWrites: [],
    messagesToAppend: [{ draft }],
    events: [],
    privateReplayWrites: [write],
  } as const;
  const scope = {
    sessionId: session.id,
    executionRunId: run.id,
    providerId: identity.providerId,
    model: identity.model,
    api: identity.api,
    selectedMessageIds: [identity.messageId],
  };
  return { store, identity, command, scope, key };
}

describe("private replay storage and Run transaction", () => {
  it("commits only ciphertext, recovers after reopening, and keeps the original ciphertext on retries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caelush-private-replay-"));
    directories.push(dir);
    const path = join(dir, "replay.db");
    const fixture = await setup(path);
    await fixture.store.execution.commit(fixture.command);
    const audit = auditDatabase(path);
    const foreignKeys = audit.prepare("PRAGMA foreign_key_list(private_replays)").all() as {
      table: string;
      on_delete: string;
    }[];
    for (const table of ["agent_messages", "agent_runs", "agent_sessions"])
      expect(
        foreignKeys.some(
          (foreignKey) => foreignKey.table === table && foreignKey.on_delete === "CASCADE",
        ),
      ).toBe(true);
    const before = audit.prepare("SELECT envelope_json FROM private_replays").get();
    const retry = await fixture.store.privateReplay.prepare(fixture.identity, bytes());
    await fixture.store.execution.commit({ ...fixture.command, privateReplayWrites: [retry] });
    expect(audit.prepare("SELECT envelope_json FROM private_replays").get()).toEqual(before);
    expect((await fixture.store.messageRecords.listByRun(fixture.command.run.id)).length).toBe(1);
    const result = await fixture.store.execution.load(fixture.command.run.id);
    expect(JSON.stringify(result).includes("C3_PRIVATE_REASONING_SENTINEL")).toBe(false);
    closeAuditDatabase(audit);
    await fixture.store.close();
    stores.splice(stores.indexOf(fixture.store), 1);
    expect((await readFile(path)).includes(bytes())).toBe(false);
    expect((await readFile(path)).includes(Buffer.from(fixture.key))).toBe(false);
    const reopened = await openCaelushStorage({ path, replayProtection: protection(fixture.key) });
    stores.push(reopened);
    const restored = await reopened.privateReplay
      .forExecution(fixture.scope)
      .read(fixture.identity);
    const expected = bytes();
    const matches = Buffer.from(restored).equals(expected);
    restored.fill(0);
    expected.fill(0);
    expect(matches).toBe(true);
    const wrongKeyStorage = await openCaelushStorage({
      path,
      replayProtection: protection(randomBytes(32)),
    });
    stores.push(wrongKeyStorage);
    await expectReplayReadDenied(
      wrongKeyStorage.privateReplay.forExecution(fixture.scope).read(fixture.identity),
    );
    const damaged = auditDatabase(path);
    const row = damaged
      .prepare("SELECT envelope_json FROM private_replays WHERE message_id = ?")
      .get(fixture.identity.messageId) as { envelope_json: string };
    const envelope = JSON.parse(row.envelope_json);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
    damaged
      .prepare("UPDATE private_replays SET envelope_json = ? WHERE message_id = ?")
      .run(JSON.stringify(envelope), fixture.identity.messageId);
    closeAuditDatabase(damaged);
    await expectReplayReadDenied(
      reopened.privateReplay.forExecution(fixture.scope).read(fixture.identity),
    );
  });

  it("refuses conflicts, missing references, unauthorized scopes and altered identities", async () => {
    const { store, identity, command, scope } = await setup();
    await store.execution.commit(command);
    const secondRun = makeRun(command.run.sessionId);
    await store.runs.insert(secondRun);
    await expectReplayReadDenied(
      store.privateReplay.forExecution({ ...scope, executionRunId: secondRun.id }).read(identity),
    );
    const conflict = await store.privateReplay.prepare(identity, Buffer.from("different"));
    await expect(
      store.execution.commit({ ...command, messagesToAppend: [], privateReplayWrites: [conflict] }),
    ).rejects.toThrow();
    for (const changes of [
      { sessionId: "other" },
      { executionRunId: "other" },
      { providerId: "other" },
      { model: "other" },
      { api: "other" },
      { selectedMessageIds: [] },
    ]) {
      await expectReplayReadDenied(
        store.privateReplay.forExecution({ ...scope, ...changes }).read(identity),
      );
    }
    for (const field of ["runId", "sessionId", "callId", "messageId"] as const)
      await expectReplayReadDenied(
        store.privateReplay.forExecution(scope).read({ ...identity, [field]: "other" }),
      );
    const orphan = await store.privateReplay.prepare({ ...identity, messageId: "orphan" }, bytes());
    await expect(
      store.execution.commit({ ...command, messagesToAppend: [], privateReplayWrites: [orphan] }),
    ).rejects.toThrow();
  });

  it("rolls back Assistant and replay together when a later transaction write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caelush-replay-rollback-"));
    directories.push(dir);
    const path = join(dir, "db");
    const { store, command } = await setup(path);
    const audit = auditDatabase(path);
    audit.exec(
      "CREATE TRIGGER reject_replay BEFORE INSERT ON private_replays BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    await expect(store.execution.commit(command)).rejects.toThrow();
    expect((await store.messageRecords.listByRun(command.run.id)).length).toBe(0);
    expect(audit.prepare("SELECT COUNT(*) AS n FROM private_replays").get()?.n).toBe(0);
    closeAuditDatabase(audit);
  });

  it("rejects a reference without replay and rejects operation without keys", async () => {
    const { store, command, identity } = await setup();
    await expect(store.execution.commit({ ...command, privateReplayWrites: [] })).rejects.toThrow();
    expect((await store.messageRecords.listByRun(command.run.id)).length).toBe(0);
    const empty = await openCaelushStorage({ path: ":memory:" });
    stores.push(empty);
    await expect(empty.privateReplay.prepare(identity, bytes())).rejects.toThrow(
      "Private replay unavailable.",
    );
  });
});

function auditDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  auditDatabases.push(database);
  return database;
}

function closeAuditDatabase(database: DatabaseSync): void {
  const index = auditDatabases.indexOf(database);
  if (index >= 0) {
    auditDatabases.splice(index, 1);
    database.close();
  }
}
