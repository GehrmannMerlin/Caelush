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
      composerEnabled: false,
      activity: "Starting",
    });
  });
});
