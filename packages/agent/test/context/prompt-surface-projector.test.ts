import { describe, expect, it } from "vitest";

import {
  createPromptSurfaceEpoch,
  createPromptSurfaceEpochId,
  createPromptSurfaceSnapshot,
  projectPromptSurface,
  PromptSurfaceIntegrityError,
  type PromptSurfaceEpochInput,
  type PromptSurfaceSnapshotInput,
} from "@caelush/agent";
import { createRunId, createTimestampMs } from "@caelush/protocol";

const firstRun = createRunId();
const secondRun = createRunId();
const timestamp = createTimestampMs(10);

function makeEpoch(overrides: Partial<PromptSurfaceEpochInput> = {}) {
  return createPromptSurfaceEpoch({
    runId: firstRun,
    epochId: createPromptSurfaceEpochId("epoch-1"),
    modelRef: { provider: "deepseek", model: "v4.1-flash" },
    stableHeadFingerprint: `sha256:${"1".repeat(64)}`,
    toolSchemaFingerprint: `sha256:${"2".repeat(64)}`,
    cacheSettingsFingerprint: `sha256:${"3".repeat(64)}`,
    resetReason: "INITIAL",
    createdStepSequence: 1,
    createdAt: timestamp,
    ...overrides,
  });
}

function makeSnapshot(overrides: Partial<PromptSurfaceSnapshotInput> = {}) {
  return createPromptSurfaceSnapshot({
    runId: firstRun,
    epochId: createPromptSurfaceEpochId("epoch-1"),
    ordinal: 1,
    anchor: {
      messageId: "amsg_prompt_surface_anchor_1" as never,
      runId: firstRun,
      conversationTurnId: "cturn_prompt_surface_anchor_1" as never,
      sequence: 1,
    },
    sourceStepSequence: 1,
    kind: "RUNTIME_CONTEXT_SNAPSHOT",
    content: "runtime context",
    createdAt: timestamp,
    ...overrides,
  });
}

describe("Prompt Surface projector", () => {
  it("hashes exact UTF-8 content and emits a sourced user-role projection", () => {
    const epoch = makeEpoch();
    const snapshot = makeSnapshot({
      content: "snapshot café 😀",
      ordinal: 1,
      anchor: {
        messageId: "amsg_prompt_surface_anchor_1" as never,
        runId: firstRun,
        conversationTurnId: "cturn_prompt_surface_anchor_1" as never,
        sequence: 4,
      },
      sourceStepSequence: 2,
    });

    expect(snapshot.contentHash).toBe(
      "6ba7eee2689ff65bf3db9c8fff72b4921d398539505443f6a50aaa0567113f4b",
    );
    expect(projectPromptSurface({ ...epoch, snapshots: [snapshot] })).toEqual([
      {
        role: "user",
        content: "snapshot café 😀",
        source: {
          kind: "RUNTIME_CONTEXT_SNAPSHOT",
          runId: firstRun,
          epochId: "epoch-1",
          ordinal: 1,
          anchor: {
            messageId: "amsg_prompt_surface_anchor_1",
            runId: firstRun,
            conversationTurnId: "cturn_prompt_surface_anchor_1",
            sequence: 4,
          },
          sourceStepSequence: 2,
          contentHash: "6ba7eee2689ff65bf3db9c8fff72b4921d398539505443f6a50aaa0567113f4b",
        },
      },
    ]);
  });

  it("preserves a validated continuous snapshot order and treats an empty surface as no messages", () => {
    const epoch = makeEpoch();
    const first = makeSnapshot({ content: "first", ordinal: 1, sourceStepSequence: 1 });
    const second = makeSnapshot({
      content: "second",
      ordinal: 2,
      sourceStepSequence: 2,
      anchor: {
        messageId: "amsg_prompt_surface_anchor_2" as never,
        runId: firstRun,
        conversationTurnId: "cturn_prompt_surface_anchor_1" as never,
        sequence: 2,
      },
    });

    expect(
      projectPromptSurface({ ...epoch, snapshots: [first, second] }).map(
        (message) => message.content,
      ),
    ).toEqual(["first", "second"]);
    expect(projectPromptSurface(undefined)).toEqual([]);
    expect(() => projectPromptSurface({ ...epoch, snapshots: [second] })).toThrow(
      PromptSurfaceIntegrityError,
    );
  });

  it("rejects a snapshot that predates its epoch boundary", () => {
    const epoch = makeEpoch({ createdStepSequence: 3 });
    const snapshot = makeSnapshot({ sourceStepSequence: 2 });

    expect(() => projectPromptSurface({ ...epoch, snapshots: [snapshot] })).toThrow(
      PromptSurfaceIntegrityError,
    );
  });

  it("fails closed for a wrong Run, a corrupted hash, and an unsupported snapshot role", () => {
    const epoch = makeEpoch();
    const valid = makeSnapshot();

    expect(() =>
      projectPromptSurface({
        ...epoch,
        snapshots: [{ ...valid, runId: secondRun }],
      }),
    ).toThrow(PromptSurfaceIntegrityError);
    expect(() =>
      projectPromptSurface({
        ...epoch,
        snapshots: [{ ...valid, contentHash: "0".repeat(64) }],
      }),
    ).toThrow(PromptSurfaceIntegrityError);
    expect(() =>
      createPromptSurfaceSnapshot({
        ...valid,
        kind: "assistant",
      } as unknown as PromptSurfaceSnapshotInput),
    ).toThrow(TypeError);
  });

  it("rejects oversized snapshots, too many snapshot nodes, and an oversized epoch", () => {
    const epoch = makeEpoch();

    expect(() => makeSnapshot({ content: "x".repeat(1_048_577) })).toThrow(RangeError);

    const tooMany = Array.from({ length: 129 }, (_, index) =>
      makeSnapshot({
        content: `snapshot-${index}`,
        ordinal: index + 1,
        sourceStepSequence: index + 1,
      }),
    );
    expect(() => projectPromptSurface({ ...epoch, snapshots: tooMany })).toThrow(RangeError);

    const tooLarge = Array.from({ length: 5 }, (_, index) =>
      makeSnapshot({
        content: "x".repeat(900_000),
        ordinal: index + 1,
        sourceStepSequence: index + 1,
      }),
    );
    expect(() => projectPromptSurface({ ...epoch, snapshots: tooLarge })).toThrow(RangeError);
  });
});
