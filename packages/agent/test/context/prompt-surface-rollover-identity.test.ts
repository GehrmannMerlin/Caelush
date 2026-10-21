import {
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceRecord,
  hashPromptSurfaceContent,
  promptSurfaceEpochIdentity,
  PromptSurfaceRolloverConflictError,
  rolloverPromptSurface,
  type PromptSurfaceEpoch,
  type PromptSurfaceEpochWithSnapshots,
  type PromptSurfaceRecord,
  type PromptSurfaceRolloverCommand,
  type PromptSurfaceSectionState,
  type PromptSurfaceStorePort,
} from "@caelush/agent";
import { createTimestampMs, createRunId, type RunId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";

/**
 * The rollover boundary, tested where the failure actually happened.
 *
 * ```text
 * Agent decides the epoch is full
 *   → rolloverPromptSurface builds the next epoch and its baseline
 *   → PromptSurfaceStorePort.rolloverEpoch(command)
 *   → Storage re-validates every field of `expectedCurrentEpoch`
 * ```
 *
 * The production failure was a *shape* failure: the Agent handed the store the wide
 * `PromptSurfaceEpochWithSnapshots` object, TypeScript accepted it structurally, and the store's
 * exact-key check rejected it at runtime. A store stub that ignores the shape cannot catch that, so
 * the stub here validates identity exactly the way Storage does.
 */

const RUN_ID = createRunId();

function identityOf(source: PromptSurfaceEpochWithSnapshots): PromptSurfaceEpoch {
  return {
    formatVersion: source.formatVersion,
    runId: source.runId,
    epochId: source.epochId,
    modelRef: source.modelRef,
    stableHeadFingerprint: source.stableHeadFingerprint,
    toolSchemaFingerprint: source.toolSchemaFingerprint,
    cacheSettingsFingerprint: source.cacheSettingsFingerprint,
    resetReason: source.resetReason,
    createdStepSequence: source.createdStepSequence,
    createdAt: source.createdAt,
  };
}

const EPOCH_IDENTITY_KEYS = Object.keys(identityOf(makeSourceEpoch())).sort();

function makeSourceEpoch(): PromptSurfaceEpochWithSnapshots {
  const epoch = createPromptSurfaceEpoch({
    runId: RUN_ID as RunId,
    formatVersion: 3,
    epochId: "epoch-initial",
    modelRef: { provider: "deepseek", model: "v4.1-flash" },
    stableHeadFingerprint: `sha256:${"1".repeat(64)}`,
    toolSchemaFingerprint: `sha256:${"2".repeat(64)}`,
    cacheSettingsFingerprint: `sha256:${"3".repeat(64)}`,
    resetReason: "INITIAL",
    createdStepSequence: 1,
    createdAt: createTimestampMs(1_000),
  });
  return Object.freeze({ ...epoch, snapshots: [], records: [], sectionStates: [] });
}

function sectionState(label: string, text: string): PromptSurfaceSectionState {
  const content = `<section authority="REFERENCE" stability="DYNAMIC" sensitivity="INTERNAL" priority="NORMAL" freshness="CURRENT" label="${label}"><![CDATA[${text}]]></section>`;
  return Object.freeze({
    stateKey: `sha256:${hashPromptSurfaceContent(`fixture\0${label}`)}`,
    contentHash: hashPromptSurfaceContent(content),
    content,
  });
}

/**
 * A store port that enforces the same exact-key identity contract the SQLite adapter enforces.
 *
 * This is deliberately stricter than a `vi.fn()`: the point of the regression is that a *shape*
 * mismatch between two components that each pass their own tests must fail here rather than in
 * production at the 129th record.
 */
function createStrictStore() {
  const commands: PromptSurfaceRolloverCommand[] = [];
  const committed = new Map<string, PromptSurfaceEpochWithSnapshots>();
  let current = makeSourceEpoch();
  return {
    commands,
    committed,
    get current(): PromptSurfaceEpochWithSnapshots {
      return current;
    },
    port: {
      async getCurrent(): Promise<PromptSurfaceEpoch | undefined> {
        return identityOf(current);
      },
      async createEpoch(): Promise<void> {
        throw new Error("createEpoch is not used by a rollover");
      },
      async appendSnapshot(): Promise<never> {
        throw new Error("appendSnapshot is not used by a rollover");
      },
      async appendRecord(): Promise<never> {
        throw new Error("appendRecord is not used by a rollover");
      },
      async rolloverEpoch(command: PromptSurfaceRolloverCommand) {
        commands.push(command);
        const keys = Object.keys(command.expectedCurrentEpoch).sort();
        if (keys.join(",") !== EPOCH_IDENTITY_KEYS.join(",")) {
          throw new TypeError("Prompt Surface epoch has an unsupported shape.");
        }
        const existing = committed.get(command.newEpoch.epochId);
        if (existing !== undefined) {
          const baseline = existing.records?.[0];
          if (baseline?.contentHash !== command.baseline.contentHash) {
            throw new PromptSurfaceRolloverConflictError(
              "Prompt Surface rollover operation is bound to a different baseline.",
            );
          }
          return "IDEMPOTENT" as const;
        }
        if (command.expectedCurrentEpoch.epochId !== current.epochId) {
          throw new PromptSurfaceRolloverConflictError(
            "Prompt Surface rollover did not target the expected current epoch.",
          );
        }
        const next: PromptSurfaceEpochWithSnapshots = Object.freeze({
          ...command.newEpoch,
          snapshots: [],
          records: [command.baseline],
          sectionStates: command.expectedSectionStates,
        });
        committed.set(command.newEpoch.epochId, next);
        current = next;
        return "COMMITTED" as const;
      },
      async readEpoch(_runId: RunId, epochId: ReturnType<typeof createPromptSurfaceEpochId>) {
        return committed.get(epochId);
      },
    } satisfies PromptSurfaceStorePort,
  };
}

describe("rolloverPromptSurface identity boundary", () => {
  it("passes only the ten canonical identity fields to the store", async () => {
    const store = createStrictStore();
    const states = [sectionState("work-progress", "current work")];
    const outcome = await rolloverPromptSurface({
      store: store.port,
      epoch: store.current,
      stepSequence: 129,
      anchor: {
        messageId: "amsg_rollover_identity" as never,
        runId: RUN_ID as RunId,
        conversationTurnId: "cturn_rollover_identity" as never,
        sequence: 300,
      },
      targetSectionStates: states,
      decisionFingerprint: "a".repeat(64),
      createdAt: createTimestampMs(2_000),
    });

    expect(outcome.status).toBe("COMMITTED");
    expect(Object.keys(store.commands[0]!.expectedCurrentEpoch).sort()).toEqual(EPOCH_IDENTITY_KEYS);
    expect(store.commands[0]!.expectedCurrentEpoch).not.toHaveProperty("snapshots");
    expect(store.commands[0]!.expectedCurrentEpoch).not.toHaveProperty("records");
    expect(store.commands[0]!.expectedCurrentEpoch).not.toHaveProperty("sectionStates");
    expect(Object.keys(outcome.epoch)).toContain("records");
    expect(outcome.epoch.resetReason).toBe("CAPACITY_ROLLOVER");
  });

  it("replays the same transition as IDEMPOTENT after a lost response", async () => {
    const store = createStrictStore();
    const states = [sectionState("work-progress", "current work")];
    const request = {
      store: store.port,
      epoch: store.current,
      stepSequence: 129,
      anchor: {
        messageId: "amsg_rollover_replay" as never,
        runId: RUN_ID as RunId,
        conversationTurnId: "cturn_rollover_replay" as never,
        sequence: 301,
      },
      targetSectionStates: states,
      decisionFingerprint: "b".repeat(64),
      createdAt: createTimestampMs(3_000),
    };
    const first = await rolloverPromptSurface(request);
    const second = await rolloverPromptSurface(request);
    expect(first.status).toBe("COMMITTED");
    expect(second.status).toBe("IDEMPOTENT");
    expect(second.epoch.epochId).toBe(first.epoch.epochId);
    expect(store.committed.size).toBe(1);
  });
});

describe("promptSurfaceEpochIdentity", () => {
  it("copies exactly the canonical fields and never leaks replay state", () => {
    const source = makeSourceEpoch();
    const identity = promptSurfaceEpochIdentity(source);
    expect(Object.keys(identity).sort()).toEqual(EPOCH_IDENTITY_KEYS);
    expect(identity.epochId).toBe(source.epochId);
    expect(identity.modelRef).toEqual(source.modelRef);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("does not alias the mutable Section or record collections", () => {
    const source: PromptSurfaceEpochWithSnapshots = Object.freeze({
      ...makeSourceEpoch(),
      records: [{} as PromptSurfaceRecord],
      sectionStates: [sectionState("work-progress", "x")],
    });
    const identity = promptSurfaceEpochIdentity(source);
    expect(Object.keys(identity)).toHaveLength(10);
    expect(identity).not.toHaveProperty("records");
  });

  it("preserves the exact record ordering used by the durable baseline count", () => {
    const epoch = makeSourceEpoch();
    const record = createPromptSurfaceRecord({
      runId: epoch.runId,
      epochId: createPromptSurfaceEpochId(epoch.epochId),
      ordinal: 1,
      anchor: {
        messageId: "amsg_identity_record" as never,
        runId: epoch.runId,
        conversationTurnId: "cturn_identity_record" as never,
        sequence: 1,
      },
      sourceStepSequence: 1,
      kind: "BASELINE",
      updates: [{ op: "SET", ...sectionState("work-progress", "x") }],
      decisionFingerprint: "c".repeat(64),
      createdAt: createTimestampMs(1_500),
    });
    const withRecord: PromptSurfaceEpochWithSnapshots = Object.freeze({
      ...epoch,
      records: [record],
      sectionStates: [sectionState("work-progress", "x")],
    });
    expect(promptSurfaceEpochIdentity(withRecord).createdStepSequence).toBe(1);
    expect(withRecord.records).toHaveLength(1);
  });
});
