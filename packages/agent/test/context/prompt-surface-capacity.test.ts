import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROMPT_SURFACE_LIMITS,
  assessPromptSurfaceBaseline,
  decidePromptSurfaceCapacity,
  promptSurfaceBaselineByteLength,
  type PromptSurfaceRecordKind,
  type PromptSurfaceSectionState,
} from "@caelush/agent";
import { renderPromptSurfaceRecord, diffPromptSurfaceSections } from "@caelush/agent";

function sectionState(index: number, text: string): PromptSurfaceSectionState {
  const label = `key-${String(index)}`;
  const content = [
    `<section authority="RUNTIME_FACT" stability="DYNAMIC" sensitivity="INTERNAL" priority="NORMAL" freshness="CURRENT" label="${label}">`,
    `<![CDATA[${text}]]>`,
    "</section>",
  ].join("");
  return Object.freeze({
    stateKey: `sha256:${createHash("sha256").update(label, "utf8").digest("hex")}`,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    content,
  });
}

function decisions(
  count: number,
  kind: PromptSurfaceRecordKind,
  byteLength: number,
): readonly { kind: PromptSurfaceRecordKind; byteLength: number }[] {
  return Object.freeze(
    Array.from({ length: count }, () => Object.freeze({ kind, byteLength })),
  );
}

const TARGET = Object.freeze([sectionState(1, "workspace state: clean")]);

describe("Prompt Surface capacity decisions", () => {
  it("appends while the epoch stays inside every bound, including exactly on a bound", () => {
    expect(
      decidePromptSurfaceCapacity({
        epoch: { records: decisions(127, "DELTA", 64) },
        candidate: { kind: "DELTA", byteLength: 64 },
        targetSectionStates: TARGET,
      }),
    ).toEqual({ kind: "APPEND" });
  });

  it("requires a rollover for the 129th visible decision instead of failing", () => {
    const decision = decidePromptSurfaceCapacity({
      epoch: { records: decisions(128, "DELTA", 64) },
      candidate: { kind: "DELTA", byteLength: 64 },
      targetSectionStates: TARGET,
    });
    expect(decision).toEqual({
      kind: "ROLLOVER_REQUIRED",
      dimension: "VISIBLE_RECORDS",
      observed: 129,
      limit: PROMPT_SURFACE_LIMITS.maxEpochSnapshots,
    });
  });

  it("keeps NOOP decisions out of the visible count but still counts them as decisions", () => {
    expect(
      decidePromptSurfaceCapacity({
        epoch: { records: decisions(128, "DELTA", 64) },
        candidate: { kind: "NOOP", byteLength: 0 },
        targetSectionStates: TARGET,
      }),
    ).toEqual({ kind: "APPEND" });

    expect(
      decidePromptSurfaceCapacity({
        epoch: { records: decisions(PROMPT_SURFACE_LIMITS.maxEpochRecords, "NOOP", 0) },
        candidate: { kind: "NOOP", byteLength: 0 },
        targetSectionStates: TARGET,
      }),
    ).toEqual({
      kind: "ROLLOVER_REQUIRED",
      dimension: "DECISION_RECORDS",
      observed: PROMPT_SURFACE_LIMITS.maxEpochRecords + 1,
      limit: PROMPT_SURFACE_LIMITS.maxEpochRecords,
    });
  });

  it("measures the epoch in UTF-8 bytes and rolls over before the byte bound", () => {
    const max = PROMPT_SURFACE_LIMITS.maxEpochUtf8Bytes;
    expect(
      decidePromptSurfaceCapacity({
        epoch: { records: decisions(4, "DELTA", max / 4) },
        candidate: { kind: "DELTA", byteLength: 1 },
        targetSectionStates: TARGET,
      }),
    ).toEqual({
      kind: "ROLLOVER_REQUIRED",
      dimension: "EPOCH_UTF8_BYTES",
      observed: max + 1,
      limit: max,
    });
    expect(
      decidePromptSurfaceCapacity({
        epoch: { records: decisions(4, "DELTA", max / 4 - 1) },
        candidate: { kind: "DELTA", byteLength: 1 },
        targetSectionStates: TARGET,
      }),
    ).toEqual({ kind: "APPEND" });
  });

  it("reports a baseline that cannot fit in one epoch as terminal, not as a rollover", () => {
    // One Section state may use the whole single-record budget; its rendered baseline then cannot.
    const padding =
      PROMPT_SURFACE_LIMITS.maxSnapshotUtf8Bytes - Buffer.byteLength(sectionState(1, "").content);
    const oversized = [sectionState(1, "a".repeat(padding))];
    expect(Buffer.byteLength(oversized[0]!.content, "utf8")).toBe(
      PROMPT_SURFACE_LIMITS.maxSnapshotUtf8Bytes,
    );
    expect(
      decidePromptSurfaceCapacity({
        epoch: { records: decisions(128, "DELTA", 64) },
        candidate: { kind: "DELTA", byteLength: 64 },
        targetSectionStates: oversized,
      }),
    ).toEqual({
      kind: "BASELINE_TOO_LARGE",
      dimension: "BASELINE_UTF8_BYTES",
      observed: promptSurfaceBaselineByteLength(oversized),
      limit: PROMPT_SURFACE_LIMITS.maxSnapshotUtf8Bytes,
    });
  });

  it("reports an over-wide Section view as terminal", () => {
    const tooMany = Array.from(
      { length: PROMPT_SURFACE_LIMITS.maxEpochSectionStates + 1 },
      (_unused, index) => sectionState(index, `value ${String(index)}`),
    );
    expect(
      decidePromptSurfaceCapacity({
        epoch: { records: decisions(128, "DELTA", 64) },
        candidate: { kind: "DELTA", byteLength: 64 },
        targetSectionStates: tooMany,
      }),
    ).toEqual({
      kind: "BASELINE_TOO_LARGE",
      dimension: "SECTION_STATES",
      observed: PROMPT_SURFACE_LIMITS.maxEpochSectionStates + 1,
      limit: PROMPT_SURFACE_LIMITS.maxEpochSectionStates,
    });
  });

  it("treats a baseline with room left as rollover-eligible", () => {
    expect(assessPromptSurfaceBaseline(TARGET)).toBeUndefined();
    expect(
      promptSurfaceBaselineByteLength(TARGET),
      "byte length must match the durable rendering",
    ).toBe(
      Buffer.byteLength(
        renderPromptSurfaceRecord("BASELINE", diffPromptSurfaceSections([], TARGET, true).updates),
        "utf8",
      ),
    );
  });

  it("counts Unicode Section content in UTF-8 bytes, not characters", () => {
    const unicode = [sectionState(1, "状态：已完成 ✓ ".repeat(64))];
    const rendered = renderPromptSurfaceRecord(
      "BASELINE",
      diffPromptSurfaceSections([], unicode, true).updates,
    );
    expect(promptSurfaceBaselineByteLength(unicode)).toBe(
      Buffer.byteLength(rendered, "utf8"),
    );
    expect(promptSurfaceBaselineByteLength(unicode)).toBeGreaterThan(rendered.length);
  });

  it("is deterministic for identical input", () => {
    const input = {
      epoch: { records: decisions(128, "DELTA", 64) },
      candidate: { kind: "DELTA" as const, byteLength: 64 },
      targetSectionStates: TARGET,
    };
    expect(decidePromptSurfaceCapacity(input)).toEqual(decidePromptSurfaceCapacity(input));
  });
});
