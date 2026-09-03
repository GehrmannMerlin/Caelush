import { describe, expect, it } from "vitest";
import {
  ProgressLedger,
  ResourceLoopDetector,
  fingerprintToolRequest,
  fingerprintToolResult,
} from "../src/index.js";

const progressPolicy = {
  windowTurns: 8,
  identicalCallNudgeThreshold: 3,
  noProgressTurnsBeforeReplan: 4,
  replansBeforePause: 2,
};

describe("resource progress ledger", () => {
  it("creates stable versioned request and result fingerprints", () => {
    expect(
      fingerprintToolRequest("read_file", { path: "src/a.ts", options: { encoding: "utf8" } }),
    ).toBe(
      fingerprintToolRequest("read_file", { options: { encoding: "utf8" }, path: "src/a.ts" }),
    );
    expect(fingerprintToolResult({ content: "A", isError: false })).not.toBe(
      fingerprintToolResult({ content: "B", isError: false }),
    );
    expect(fingerprintToolRequest("read_file", { path: "src/a.ts" })).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it("treats a changed result as progress and bounds the incremental window", () => {
    const ledger = new ProgressLedger({ maxTurns: progressPolicy.windowTurns, maxFingerprints: 4 });
    ledger.record({
      turn: 1,
      requestFingerprint: "v1:req-a",
      resultFingerprint: "v1:result-a",
      signal: { kind: "NEW_DISCOVERY" },
    });
    const unchanged = ledger.record({
      turn: 2,
      requestFingerprint: "v1:req-a",
      resultFingerprint: "v1:result-a",
    });
    const changed = ledger.record({
      turn: 3,
      requestFingerprint: "v1:req-a",
      resultFingerprint: "v1:result-b",
    });

    expect(unchanged.progressed).toBe(false);
    expect(changed.progressed).toBe(true);
    for (let turn = 4; turn <= 12; turn += 1) {
      ledger.record({
        turn,
        requestFingerprint: `v1:req-${turn}`,
        resultFingerprint: `v1:result-${turn}`,
      });
    }
    expect(ledger.snapshot().observations).toHaveLength(4);
    expect(ledger.snapshot().observations.at(-1)?.turn).toBe(12);
  });
});

describe("resource loop detector", () => {
  it("escalates exact repeats without treating the first repeat as a hard stop", () => {
    const detector = new ResourceLoopDetector(progressPolicy);
    expect(detector.evaluate({ exactRepeatCount: 1, noProgressTurns: 1, replanCount: 0 })).toBe(
      "OBSERVE",
    );
    expect(detector.evaluate({ exactRepeatCount: 3, noProgressTurns: 2, replanCount: 0 })).toBe(
      "NUDGE",
    );
    expect(detector.evaluate({ exactRepeatCount: 0, noProgressTurns: 4, replanCount: 0 })).toBe(
      "FORCED_REPLAN",
    );
    expect(detector.evaluate({ exactRepeatCount: 0, noProgressTurns: 4, replanCount: 2 })).toBe(
      "WAITING_RESOURCE",
    );
  });
});
