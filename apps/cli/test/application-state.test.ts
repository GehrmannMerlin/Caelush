import { describe, expect, it } from "vitest";
import { createInitialCliState } from "../src/application/cli-state.js";

describe("CLI application state", () => {
  it("starts in a non-interactive bootstrap state", () => {
    expect(createInitialCliState()).toEqual({
      bootstrap: "STARTING",
      displayHistory: [],
      timeline: expect.objectContaining({
        settled: [],
        activeTools: [],
        activeProcesses: [],
      }),
      transportState: "CONNECTED",
      controlMode: "NONE",
      sessionCandidates: [],
      sessionSelectionIndex: 0,
      recoveryCandidates: [],
      recoverySelectionIndex: 0,
      composerEnabled: false,
      activity: "Starting",
    });
  });
});
