import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTimestampMs, type RunId } from "@caelush/protocol";
import {
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceSnapshot,
  createPromptSurfaceRecord,
  hashPromptSurfaceContent,
  type PromptSurfaceEpochInput,
  type PromptSurfaceSnapshotInput,
  type PromptSurfaceRecordInput,
} from "@caelush/agent";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  openCaelushStorage,
  type CaelushStorage,
} from "@caelush/storage";
import { afterEach, describe, expect, it } from "vitest";
import { makeRun, makeSession } from "./support/fixtures.js";

const stores: CaelushStorage[] = [];
const rawDatabases: DatabaseSync[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of rawDatabases.splice(0)) database.close();
  for (const storage of stores.splice(0)) await storage.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function addRun(storage: CaelushStorage) {
  const session = makeSession();
  const run = makeRun(session.id);
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  return run;
}

function makeEpoch(
  runId: RunId,
  epochId: string,
  createdStepSequence: number,
  overrides: Partial<PromptSurfaceEpochInput> = {},
) {
  return createPromptSurfaceEpoch({
    runId,
    epochId: createPromptSurfaceEpochId(epochId),
    modelRef: { provider: "deepseek", model: "v4.1-flash" },
    stableHeadFingerprint: `sha256:${"1".repeat(64)}`,
    toolSchemaFingerprint: `sha256:${"2".repeat(64)}`,
    cacheSettingsFingerprint: `sha256:${"3".repeat(64)}`,
    resetReason: createdStepSequence === 1 ? "INITIAL" : "MODEL_CHANGED",
    createdStepSequence,
    createdAt: createTimestampMs(createdStepSequence + 2),
    ...overrides,
  });
}

function makeSnapshot(
  epoch: ReturnType<typeof makeEpoch>,
  overrides: Partial<PromptSurfaceSnapshotInput> = {},
) {
  return createPromptSurfaceSnapshot({
    runId: epoch.runId,
    epochId: epoch.epochId,
    ordinal: 1,
    anchor: anchorFor(epoch, 1),
    sourceStepSequence: 1,
    kind: "RUNTIME_CONTEXT_SNAPSHOT",
    content: "bounded runtime snapshot",
    createdAt: createTimestampMs(10),
    ...overrides,
  });
}

function anchorFor(epoch: ReturnType<typeof makeEpoch>, sequence: number) {
  return {
    messageId: `amsg_prompt_surface_${String(sequence)}` as never,
    runId: epoch.runId,
    conversationTurnId: "cturn_prompt_surface_store" as never,
    sequence,
  };
}

function makeSetUpdate(key: string, content: string) {
  const modelContent = `<section authority="REFERENCE" stability="SEMI_STABLE" sensitivity="INTERNAL" priority="NORMAL" freshness="CURRENT" label="fixture"><![CDATA[${content}]]></section>`;
  return {
    op: "SET" as const,
    stateKey: `sha256:${key.repeat(64 / key.length)}`,
    contentHash: hashPromptSurfaceContent(modelContent),
    content: modelContent,
  };
}

function makeV3Record(
  epoch: ReturnType<typeof makeEpoch>,
  input: Omit<PromptSurfaceRecordInput, "runId" | "epochId" | "createdAt">,
) {
  return createPromptSurfaceRecord({
    runId: epoch.runId,
    epochId: epoch.epochId,
    createdAt: createTimestampMs(100 + input.sourceStepSequence),
    ...input,
  });
}

describe("SqlitePromptSurfaceStore", () => {
  it("commits V3 decisions and current Section state atomically with exact Step idempotency", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-v3-atomic", 1, { formatVersion: 3 });
    await storage.promptSurface.createEpoch(epoch);
    const firstState = makeSetUpdate("a", "file state v1");
    const baseline = makeV3Record(epoch, {
      ordinal: 1,
      anchor: anchorFor(epoch, 1),
      sourceStepSequence: 1,
      kind: "BASELINE",
      updates: [firstState],
      decisionFingerprint: "a".repeat(64),
    });

    await expect(storage.promptSurface.appendRecord(baseline, epoch, 0)).resolves.toBe("APPENDED");
    await expect(storage.promptSurface.appendRecord(baseline, epoch, 0)).resolves.toBe(
      "IDEMPOTENT",
    );
    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).resolves.toMatchObject({
      records: [baseline],
      sectionStates: [
        {
          stateKey: firstState.stateKey,
          contentHash: firstState.contentHash,
          content: firstState.content,
        },
      ],
    });

    const changedState = makeSetUpdate("a", "file state v2");
    const delta = makeV3Record(epoch, {
      ordinal: 2,
      anchor: anchorFor(epoch, 2),
      sourceStepSequence: 2,
      kind: "DELTA",
      updates: [changedState],
      decisionFingerprint: "b".repeat(64),
    });
    await expect(storage.promptSurface.appendRecord(delta, epoch, 1)).resolves.toBe("APPENDED");
    await expect(
      storage.promptSurface.appendRecord(
        makeV3Record(epoch, {
          ordinal: 2,
          anchor: anchorFor(epoch, 2),
          sourceStepSequence: 2,
          kind: "DELTA",
          updates: [firstState],
          decisionFingerprint: "c".repeat(64),
        }),
        epoch,
        2,
      ),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("rolls back a V3 record when its Section state write fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-prompt-surface-v3-atomic-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const storage = await openCaelushStorage({ path: databasePath });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-v3-rollback", 1, { formatVersion: 3 });
    await storage.promptSurface.createEpoch(epoch);
    const original = makeSetUpdate("a", "original");
    const baseline = makeV3Record(epoch, {
      ordinal: 1,
      anchor: anchorFor(epoch, 1),
      sourceStepSequence: 1,
      kind: "BASELINE",
      updates: [original],
      decisionFingerprint: "a".repeat(64),
    });
    await storage.promptSurface.appendRecord(baseline, epoch, 0);

    const raw = new DatabaseSync(databasePath);
    rawDatabases.push(raw);
    raw.exec(`CREATE TRIGGER fail_v3_section_update BEFORE UPDATE ON prompt_surface_section_state
      BEGIN SELECT RAISE(ABORT, 'injected Section state failure'); END;`);
    const changed = makeSetUpdate("a", "changed");
    const delta = makeV3Record(epoch, {
      ordinal: 2,
      anchor: anchorFor(epoch, 2),
      sourceStepSequence: 2,
      kind: "DELTA",
      updates: [changed],
      decisionFingerprint: "b".repeat(64),
    });

    await expect(storage.promptSurface.appendRecord(delta, epoch, 1)).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).resolves.toMatchObject({
      records: [baseline],
      sectionStates: [
        {
          stateKey: original.stateKey,
          contentHash: original.contentHash,
          content: original.content,
        },
      ],
    });
  });

  it("fails closed when durable V3 Section state disagrees with the committed record log", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-prompt-surface-v3-corrupt-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const storage = await openCaelushStorage({ path: databasePath });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-v3-corrupt-state", 1, { formatVersion: 3 });
    await storage.promptSurface.createEpoch(epoch);
    const state = makeSetUpdate("a", "original");
    const baseline = makeV3Record(epoch, {
      ordinal: 1,
      anchor: anchorFor(epoch, 1),
      sourceStepSequence: 1,
      kind: "BASELINE",
      updates: [state],
      decisionFingerprint: "a".repeat(64),
    });
    await storage.promptSurface.appendRecord(baseline, epoch, 0);

    const raw = new DatabaseSync(databasePath);
    rawDatabases.push(raw);
    raw
      .prepare(
        "UPDATE prompt_surface_section_state SET content = ? WHERE run_id = ? AND epoch_id = ? AND state_key = ?",
      )
      .run("corrupt durable state", run.id, epoch.epochId, state.stateKey);

    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).rejects.toBeInstanceOf(
      StorageDecodeError,
    );
  });

  it("starts empty and makes a newly created compatible boundary the current epoch", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const initial = makeEpoch(run.id, "epoch-1", 1);
    const reset = makeEpoch(run.id, "epoch-2", 2, {
      resetReason: "MODEL_CHANGED",
      modelRef: { provider: "deepseek", model: "v4.1-pro" },
    });

    expect(storage.promptSurface).toBeDefined();
    await expect(storage.promptSurface.getCurrent(run.id)).resolves.toBeUndefined();

    await storage.promptSurface.createEpoch(initial);
    await storage.promptSurface.createEpoch(reset);

    await expect(storage.promptSurface.getCurrent(run.id)).resolves.toEqual(reset);
    await expect(storage.promptSurface.readEpoch(run.id, initial.epochId)).resolves.toEqual({
      ...initial,
      snapshots: [],
    });
    await expect(
      storage.promptSurface.appendSnapshot(makeSnapshot(initial), initial),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it("allows a recovery reset in the same durable Step and makes the committed epoch current", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const initial = makeEpoch(run.id, "epoch-same-step-initial", 1);
    const recovered = makeEpoch(run.id, "epoch-same-step-recovered", 1, {
      resetReason: "RECOVERY_INCOMPATIBLE",
      stableHeadFingerprint: `sha256:${"4".repeat(64)}`,
      createdAt: createTimestampMs(30),
    });
    await storage.promptSurface.createEpoch(initial);
    await storage.promptSurface.appendSnapshot(makeSnapshot(initial), initial);

    await expect(storage.promptSurface.createEpoch(recovered)).resolves.toBeUndefined();
    await expect(storage.promptSurface.getCurrent(run.id)).resolves.toEqual(recovered);
    await expect(storage.promptSurface.readEpoch(run.id, initial.epochId)).resolves.toMatchObject({
      snapshots: [makeSnapshot(initial)],
    });
    await expect(storage.promptSurface.readEpoch(run.id, recovered.epochId)).resolves.toEqual({
      ...recovered,
      snapshots: [],
    });
  });

  it("binds model and cache-identity fingerprints immutably to an epoch id", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-immutable", 1);
    await storage.promptSurface.createEpoch(epoch);
    await expect(storage.promptSurface.createEpoch(epoch)).resolves.toBeUndefined();

    const incompatibleMetadata: Partial<PromptSurfaceEpochInput>[] = [
      { modelRef: { provider: "deepseek", model: "v4.1-pro" } },
      { stableHeadFingerprint: `sha256:${"4".repeat(64)}` },
      { toolSchemaFingerprint: `sha256:${"5".repeat(64)}` },
      { cacheSettingsFingerprint: `sha256:${"6".repeat(64)}` },
    ];
    for (const metadata of incompatibleMetadata) {
      await expect(
        storage.promptSurface.createEpoch(createPromptSurfaceEpoch({ ...epoch, ...metadata })),
      ).rejects.toBeInstanceOf(StorageConflictError);
    }
    await expect(storage.promptSurface.getCurrent(run.id)).resolves.toEqual(epoch);
  });

  it("requires the current frozen model and cache identity when appending", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-current-identity", 1);
    await storage.promptSurface.createEpoch(epoch);
    const snapshot = makeSnapshot(epoch);
    const incompatibleMetadata: Partial<PromptSurfaceEpochInput>[] = [
      { modelRef: { provider: "deepseek", model: "v4.1-pro" } },
      { stableHeadFingerprint: `sha256:${"4".repeat(64)}` },
      { toolSchemaFingerprint: `sha256:${"5".repeat(64)}` },
      { cacheSettingsFingerprint: `sha256:${"6".repeat(64)}` },
    ];

    for (const metadata of incompatibleMetadata) {
      await expect(
        storage.promptSurface.appendSnapshot(
          snapshot,
          createPromptSurfaceEpoch({ ...epoch, ...metadata }),
        ),
      ).rejects.toBeInstanceOf(StorageConflictError);
    }
    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).resolves.toMatchObject({
      snapshots: [],
    });
  });

  it("rejects a snapshot from before the current epoch was created", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-step-boundary", 3);
    const staleSnapshot = makeSnapshot(epoch, { sourceStepSequence: 2 });
    await storage.promptSurface.createEpoch(epoch);

    await expect(storage.promptSurface.appendSnapshot(staleSnapshot, epoch)).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).resolves.toMatchObject({
      snapshots: [],
    });
  });

  it("appends ordered snapshots and makes an exact source-step replay idempotent", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-1", 1);
    await storage.promptSurface.createEpoch(epoch);
    const first = makeSnapshot(epoch);
    const second = makeSnapshot(epoch, {
      ordinal: 2,
      anchor: anchorFor(epoch, 2),
      sourceStepSequence: 2,
      content: "second runtime snapshot",
    });

    await expect(storage.promptSurface.appendSnapshot(first, epoch)).resolves.toBe("APPENDED");
    await expect(storage.promptSurface.appendSnapshot(first, epoch)).resolves.toBe("IDEMPOTENT");
    await expect(
      storage.promptSurface.appendSnapshot(
        makeSnapshot(epoch, { content: "changed content" }),
        epoch,
      ),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await expect(storage.promptSurface.appendSnapshot(second, epoch)).resolves.toBe("APPENDED");
    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).resolves.toEqual({
      ...epoch,
      snapshots: [first, second],
    });
  });

  it("fails closed when a stored Prompt Surface anchor has only legacy sequence identity", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "caelush-prompt-surface-legacy-anchor-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const storage = await openCaelushStorage({ path: databasePath });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-legacy-anchor", 1);
    await storage.promptSurface.createEpoch(epoch);
    await storage.promptSurface.appendSnapshot(makeSnapshot(epoch), epoch);

    const raw = new DatabaseSync(databasePath);
    rawDatabases.push(raw);
    raw
      .prepare(
        `UPDATE prompt_surface_snapshots
         SET anchor_message_id = NULL, anchor_run_id = NULL, anchor_conversation_turn_id = NULL
         WHERE run_id = ? AND epoch_id = ? AND ordinal = 1`,
      )
      .run(run.id, epoch.epochId);

    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).rejects.toBeInstanceOf(
      StorageDecodeError,
    );
  });

  it("rejects duplicate ordinals, duplicate source steps, and snapshots for another Run", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const firstRun = await addRun(storage);
    const secondRun = await addRun(storage);
    const epoch = makeEpoch(firstRun.id, "epoch-1", 1);
    await storage.promptSurface.createEpoch(epoch);
    await storage.promptSurface.appendSnapshot(makeSnapshot(epoch), epoch);

    await expect(
      storage.promptSurface.appendSnapshot(
        makeSnapshot(epoch, { ordinal: 1, sourceStepSequence: 2, content: "duplicate ordinal" }),
        epoch,
      ),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await expect(
      storage.promptSurface.appendSnapshot(
        makeSnapshot(epoch, {
          ordinal: 2,
          sourceStepSequence: 1,
          content: "duplicate source step",
        }),
        epoch,
      ),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await expect(
      storage.promptSurface.appendSnapshot(
        makeSnapshot(epoch, { runId: secondRun.id, content: "cross-run snapshot" }),
        epoch,
      ),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await expect(
      storage.promptSurface.readEpoch(secondRun.id, epoch.epochId),
    ).resolves.toBeUndefined();
  });

  it("rejects a partial read when a stored hash or ordinal sequence is corrupt", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-prompt-surface-corrupt-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const storage = await openCaelushStorage({ path: databasePath });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-1", 1);
    await storage.promptSurface.createEpoch(epoch);
    const first = makeSnapshot(epoch);
    const second = makeSnapshot(epoch, {
      ordinal: 2,
      anchor: anchorFor(epoch, 2),
      sourceStepSequence: 2,
      content: "second runtime snapshot",
    });
    await storage.promptSurface.appendSnapshot(first, epoch);
    await storage.promptSurface.appendSnapshot(second, epoch);
    const raw = new DatabaseSync(databasePath);
    rawDatabases.push(raw);

    raw
      .prepare(
        "UPDATE prompt_surface_snapshots SET content_hash = ? WHERE run_id = ? AND epoch_id = ? AND ordinal = ?",
      )
      .run("0".repeat(64), run.id, epoch.epochId, 2);
    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).rejects.toBeInstanceOf(
      StorageDecodeError,
    );

    raw
      .prepare(
        "UPDATE prompt_surface_snapshots SET content_hash = ? WHERE run_id = ? AND epoch_id = ? AND ordinal = ?",
      )
      .run(second.contentHash, run.id, epoch.epochId, 2);
    raw
      .prepare(
        "DELETE FROM prompt_surface_snapshots WHERE run_id = ? AND epoch_id = ? AND ordinal = ?",
      )
      .run(run.id, epoch.epochId, 1);
    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).rejects.toBeInstanceOf(
      StorageDecodeError,
    );
  });

  it("refuses to append onto an epoch whose existing surface is corrupt", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "caelush-prompt-surface-corrupt-append-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const storage = await openCaelushStorage({ path: databasePath });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-1", 1);
    const first = makeSnapshot(epoch);
    const second = makeSnapshot(epoch, {
      ordinal: 2,
      anchor: anchorFor(epoch, 2),
      sourceStepSequence: 2,
      content: "second runtime snapshot",
    });
    await storage.promptSurface.createEpoch(epoch);
    await storage.promptSurface.appendSnapshot(first, epoch);
    const raw = new DatabaseSync(databasePath);
    rawDatabases.push(raw);
    raw
      .prepare(
        "UPDATE prompt_surface_snapshots SET content_hash = ? WHERE run_id = ? AND epoch_id = ? AND ordinal = ?",
      )
      .run("0".repeat(64), run.id, epoch.epochId, 1);

    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).rejects.toBeInstanceOf(
      StorageDecodeError,
    );
    await expect(storage.promptSurface.appendSnapshot(second, epoch)).rejects.toBeInstanceOf(
      StorageDecodeError,
    );
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS count FROM prompt_surface_snapshots WHERE run_id = ? AND epoch_id = ?",
        )
        .get(run.id, epoch.epochId),
    ).toEqual({ count: 1 });
  });

  it("enforces the epoch byte budget without appending a partial fifth node", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-budget", 1);
    await storage.promptSurface.createEpoch(epoch);

    for (let index = 1; index <= 4; index += 1) {
      await storage.promptSurface.appendSnapshot(
        makeSnapshot(epoch, {
          ordinal: index,
          anchor: anchorFor(epoch, index),
          sourceStepSequence: index,
          content: "x".repeat(900_000),
        }),
        epoch,
      );
    }
    const fifth = makeSnapshot(epoch, {
      ordinal: 5,
      anchor: anchorFor(epoch, 5),
      sourceStepSequence: 5,
      content: "x".repeat(900_000),
    });

    await expect(storage.promptSurface.appendSnapshot(fifth, epoch)).rejects.toBeInstanceOf(
      StorageError,
    );
    const saved = await storage.promptSurface.readEpoch(run.id, epoch.epochId);
    expect(saved?.snapshots).toHaveLength(4);
  });

  it("rolls back a failed append without returning a partial surface", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-prompt-surface-rollback-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    const storage = await openCaelushStorage({ path: databasePath });
    stores.push(storage);
    const run = await addRun(storage);
    const epoch = makeEpoch(run.id, "epoch-1", 1);
    await storage.promptSurface.createEpoch(epoch);
    const first = makeSnapshot(epoch);
    await storage.promptSurface.appendSnapshot(first, epoch);
    const raw = new DatabaseSync(databasePath);
    rawDatabases.push(raw);
    raw.exec(`
      CREATE TRIGGER prompt_surface_test_abort_snapshot
      BEFORE INSERT ON prompt_surface_snapshots
      WHEN NEW.ordinal = 2
      BEGIN SELECT RAISE(ABORT, 'fixture abort'); END;
    `);
    const second = makeSnapshot(epoch, {
      ordinal: 2,
      anchor: anchorFor(epoch, 2),
      sourceStepSequence: 2,
      content: "second runtime snapshot",
    });
    await expect(storage.promptSurface.appendSnapshot(second, epoch)).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(storage.promptSurface.readEpoch(run.id, epoch.epochId)).resolves.toMatchObject({
      snapshots: [first],
    });
  });
});
