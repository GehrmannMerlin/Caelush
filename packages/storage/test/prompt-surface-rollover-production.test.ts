import {
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceRecord,
  decidePromptSurfaceCapacity,
  hashPromptSurfaceContent,
  rolloverPromptSurface,
  type PromptSurfaceEpochWithSnapshots,
  type PromptSurfaceRecord,
  type PromptSurfaceSectionState,
} from "@caelush/agent";
import {
  StorageError,
  openCaelushStorage,
  type CaelushStorage,
} from "@caelush/storage";
import { createTimestampMs, type RunId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { makeRun, makeSession } from "./support/fixtures.js";

/**
 * The production rollover path against real SQLite.
 *
 * ```text
 * 128 durable visible records (the historical epoch bound)
 *   → one more Step needs a decision
 *   → decidePromptSurfaceCapacity     ROLLOVER_REQUIRED / VISIBLE_RECORDS / 129 / 128
 *   → rolloverPromptSurface           canonical identity only
 *   → SqlitePromptSurfaceStore        exact-key validation + one atomic transaction
 * ```
 *
 * The defect this file exists for was invisible to both sides' own unit tests: the Agent passed a
 * wide object and Storage rejected unknown keys. Only the two of them composed here shows it.
 */

const stores: CaelushStorage[] = [];

afterEach(async () => {
  for (const storage of stores.splice(0)) await storage.close();
});

async function newStorageRun(): Promise<{ storage: CaelushStorage; runId: RunId }> {
  const storage = await openCaelushStorage({ path: ":memory:" });
  stores.push(storage);
  const session = makeSession();
  const run = makeRun(session.id);
  await storage.sessions.insert(session);
  await storage.runs.insert(run);
  return { storage, runId: run.id };
}

function sectionState(label: string, text: string): PromptSurfaceSectionState {
  const content = `<section authority="REFERENCE" stability="DYNAMIC" sensitivity="INTERNAL" priority="NORMAL" freshness="CURRENT" label="${label}"><![CDATA[${text}]]></section>`;
  return Object.freeze({
    stateKey: `sha256:${hashPromptSurfaceContent(`fixture\0${label}`)}`,
    contentHash: hashPromptSurfaceContent(content),
    content,
  });
}

function anchor(runId: RunId, sequence: number) {
  return {
    messageId: `amsg_ps_${String(sequence)}` as never,
    runId,
    conversationTurnId: "cturn_ps_rollover" as never,
    sequence,
  };
}

/** The ten-field epoch identity, as a caller must present it to the store's exact-key contract. */
function identityOf(epoch: PromptSurfaceEpochWithSnapshots) {
  return {
    formatVersion: epoch.formatVersion,
    runId: epoch.runId,
    epochId: epoch.epochId,
    modelRef: epoch.modelRef,
    stableHeadFingerprint: epoch.stableHeadFingerprint,
    toolSchemaFingerprint: epoch.toolSchemaFingerprint,
    cacheSettingsFingerprint: epoch.cacheSettingsFingerprint,
    resetReason: epoch.resetReason,
    createdStepSequence: epoch.createdStepSequence,
    createdAt: epoch.createdAt,
  };
}

function record(input: {
  readonly runId: RunId;
  readonly epochId: string;
  readonly ordinal: number;
  readonly sequence: number;
  readonly kind: "BASELINE" | "DELTA";
  readonly states: readonly PromptSurfaceSectionState[];
  readonly fingerprint: string;
}): PromptSurfaceRecord {
  return createPromptSurfaceRecord({
    runId: input.runId,
    epochId: createPromptSurfaceEpochId(input.epochId),
    ordinal: input.ordinal,
    anchor: anchor(input.runId, input.sequence),
    sourceStepSequence: input.sequence,
    kind: input.kind,
    updates: input.states.map((state) => Object.freeze({ op: "SET" as const, ...state })),
    decisionFingerprint: input.fingerprint,
    createdAt: createTimestampMs(1_000 + input.sequence),
  });
}

/** Persist one epoch holding exactly `visibleRecords` visible decisions (1..N). */
async function seedFullEpoch(
  storage: CaelushStorage,
  runId: RunId,
  visibleRecords: number,
): Promise<PromptSurfaceEpochWithSnapshots> {
  const epoch = createPromptSurfaceEpoch({
    runId,
    formatVersion: 3,
    epochId: "epoch-capacity",
    modelRef: { provider: "deepseek", model: "v4.1-flash" },
    stableHeadFingerprint: `sha256:${"1".repeat(64)}`,
    toolSchemaFingerprint: `sha256:${"2".repeat(64)}`,
    cacheSettingsFingerprint: `sha256:${"3".repeat(64)}`,
    resetReason: "INITIAL",
    createdStepSequence: 1,
    createdAt: createTimestampMs(1_000),
  });
  await storage.promptSurface.createEpoch(epoch);
  for (let step = 1; step <= visibleRecords; step += 1) {
    await storage.promptSurface.appendRecord(
      record({
        runId,
        epochId: epoch.epochId,
        ordinal: step,
        sequence: step,
        kind: step === 1 ? "BASELINE" : "DELTA",
        states: [sectionState("work-progress", `work at step ${String(step)}`)],
        fingerprint: step.toString(16).padStart(64, "0"),
      }),
      epoch,
      step - 1,
    );
  }
  const loaded = await storage.promptSurface.readEpoch(runId, epoch.epochId);
  if (loaded === undefined) throw new Error("seeded epoch is missing");
  return loaded;
}

describe("Prompt Surface capacity rollover against SQLite", () => {
  it("rolls the 129th visible decision into a new epoch instead of failing the Run", async () => {
    const { storage, runId } = await newStorageRun();
    const full = await seedFullEpoch(storage, runId, 128);
    const targetStates = [sectionState("work-progress", "work at step 129")];
    const candidate = record({
      runId,
      epochId: full.epochId,
      ordinal: 129,
      sequence: 129,
      kind: "DELTA",
      states: targetStates,
      fingerprint: "f".repeat(64),
    });

    expect(
      decidePromptSurfaceCapacity({
        epoch: full,
        candidate,
        targetSectionStates: targetStates,
      }),
    ).toEqual({ kind: "ROLLOVER_REQUIRED", dimension: "VISIBLE_RECORDS", observed: 129, limit: 128 });

    const outcome = await rolloverPromptSurface({
      store: storage.promptSurface,
      epoch: full,
      stepSequence: 129,
      anchor: anchor(runId, 129),
      targetSectionStates: targetStates,
      decisionFingerprint: "f".repeat(64),
      createdAt: createTimestampMs(2_000),
    });

    expect(outcome.status).toBe("COMMITTED");
    expect(outcome.epoch.resetReason).toBe("CAPACITY_ROLLOVER");
    expect(outcome.epoch.records).toHaveLength(1);
    expect(outcome.epoch.records?.[0]?.kind).toBe("BASELINE");
    expect(outcome.epoch.sectionStates).toEqual(targetStates);

    const current = await storage.promptSurface.getCurrent(runId);
    expect(current?.epochId).toBe(outcome.epoch.epochId);
    expect(current?.createdStepSequence).toBe(129);

    // The closed epoch is preserved, not deleted or rewritten: the old projection stays auditable.
    const previous = await storage.promptSurface.readEpoch(runId, full.epochId);
    expect(previous?.records).toHaveLength(128);
    expect(previous?.sectionStates).toEqual([sectionState("work-progress", "work at step 128")]);
  });

  it("chains three capacity rollovers and keeps every epoch readable", async () => {
    const { storage, runId } = await newStorageRun();
    let current = await seedFullEpoch(storage, runId, 128);
    const epochIds: string[] = [current.epochId];

    for (const step of [129, 130, 131]) {
      const targetStates = [sectionState("work-progress", `work at step ${String(step)}`)];
      const decision = decidePromptSurfaceCapacity({
        epoch: current,
        candidate: record({
          runId,
          epochId: current.epochId,
          ordinal: 1,
          sequence: step,
          kind: "DELTA",
          states: targetStates,
          fingerprint: "e".repeat(64),
        }),
        targetSectionStates: targetStates,
      });
      // Steps 129..131 are appended below the visible bound only when the epoch is under it; the
      // first transition is the capacity one and the next two are explicit re-rollovers of the same
      // bounded mechanism.
      expect(["APPEND", "ROLLOVER_REQUIRED"]).toContain(decision.kind);
      const outcome = await rolloverPromptSurface({
        store: storage.promptSurface,
        epoch: current,
        stepSequence: step,
        anchor: anchor(runId, step),
        targetSectionStates: targetStates,
        decisionFingerprint: "e".repeat(64),
        createdAt: createTimestampMs(2_000 + step),
      });
      expect(outcome.status).toBe("COMMITTED");
      current = outcome.epoch;
      epochIds.push(current.epochId);
    }

    expect(new Set(epochIds).size).toBe(4);
    for (const [index, epochId] of epochIds.entries()) {
      const stored = await storage.promptSurface.readEpoch(runId, createPromptSurfaceEpochId(epochId));
      expect(stored?.records?.length).toBe(index === 0 ? 128 : 1);
    }
    const resolved = await storage.promptSurface.getCurrent(runId);
    expect(resolved?.epochId).toBe(epochIds.at(-1));
  });

  it("answers a replayed rollover with IDEMPOTENT and never opens a second epoch", async () => {
    const { storage, runId } = await newStorageRun();
    const full = await seedFullEpoch(storage, runId, 128);
    const targetStates = [sectionState("work-progress", "work at step 129")];
    const request = {
      store: storage.promptSurface,
      epoch: full,
      stepSequence: 129,
      anchor: anchor(runId, 129),
      targetSectionStates: targetStates,
      decisionFingerprint: "d".repeat(64),
      createdAt: createTimestampMs(2_000),
    };

    const first = await rolloverPromptSurface(request);
    const replay = await rolloverPromptSurface(request);

    expect(first.status).toBe("COMMITTED");
    expect(replay.status).toBe("IDEMPOTENT");
    expect(replay.epoch.epochId).toBe(first.epoch.epochId);
    // Exactly one epoch opened: the current pointer is the epoch the first call created, and its log
    // still holds a single baseline.
    expect((await storage.promptSurface.getCurrent(runId))?.epochId).toBe(first.epoch.epochId);
    const committed = await storage.promptSurface.readEpoch(runId, first.epoch.epochId);
    expect(committed?.records).toHaveLength(1);
    expect(committed?.records?.[0]?.kind).toBe("BASELINE");
    expect(await storage.promptSurface.readEpoch(runId, full.epochId)).toBeDefined();
  });

  it("re-reads once after a concurrent CAS change instead of overwriting it", async () => {
    const { storage, runId } = await newStorageRun();
    const stale = await seedFullEpoch(storage, runId, 128);
    // Another writer records a NOOP decision for Step 129 between our read and our rollover: the log
    // moves, the visible view does not. Our frozen ordinal is now stale.
    await storage.promptSurface.appendRecord(
      record({
        runId,
        epochId: stale.epochId,
        ordinal: 129,
        sequence: 129,
        kind: "NOOP",
        states: [],
        fingerprint: "c".repeat(64),
      }),
      identityOf(stale),
      128,
    );

    const targetStates = [sectionState("work-progress", "work at step 130")];
    const outcome = await rolloverPromptSurface({
      store: storage.promptSurface,
      epoch: stale,
      stepSequence: 130,
      anchor: anchor(runId, 130),
      targetSectionStates: targetStates,
      decisionFingerprint: "b".repeat(64),
      createdAt: createTimestampMs(2_100),
    });

    expect(outcome.status).toBe("COMMITTED");
    // The concurrent decision is not lost: it stays in the closed epoch.
    const closed = await storage.promptSurface.readEpoch(runId, stale.epochId);
    expect(closed?.records).toHaveLength(129);
    expect(closed?.records?.at(-1)?.kind).toBe("NOOP");
    expect(closed?.sectionStates).toEqual([sectionState("work-progress", "work at step 128")]);
    expect(outcome.epoch.sectionStates).toEqual(targetStates);
    expect(outcome.epoch.createdStepSequence).toBe(130);
  });

  it("still rejects an epoch identity that carries replay state", async () => {
    const { storage, runId } = await newStorageRun();
    const full = await seedFullEpoch(storage, runId, 128);
    const targetStates = [sectionState("work-progress", "work at step 129")];
    const candidate = record({
      runId,
      epochId: full.epochId,
      ordinal: 1,
      sequence: 129,
      kind: "BASELINE",
      states: targetStates,
      fingerprint: "a".repeat(64),
    });

    // The contract is unchanged: Storage does not widen its exact-key check to accommodate a caller
    // that forwards its own replay state.
    await expect(
      storage.promptSurface.rolloverEpoch({
        expectedCurrentEpoch: full as never,
        expectedRecordOrdinal: 128,
        expectedDecisionFingerprint: full.records?.at(-1)?.decisionFingerprint ?? null,
        operationId: "concurrent-shape-check",
        newEpoch: createPromptSurfaceEpoch({
          runId,
          formatVersion: 3,
          epochId: "rollover-shape-check",
          modelRef: { provider: "deepseek", model: "v4.1-flash" },
          stableHeadFingerprint: `sha256:${"1".repeat(64)}`,
          toolSchemaFingerprint: `sha256:${"2".repeat(64)}`,
          cacheSettingsFingerprint: `sha256:${"3".repeat(64)}`,
          resetReason: "CAPACITY_ROLLOVER",
          createdStepSequence: 129,
          createdAt: createTimestampMs(2_000),
        }),
        baseline: candidate,
        expectedSectionStates: targetStates,
      }),
    ).rejects.toBeInstanceOf(StorageError);
  });
});
