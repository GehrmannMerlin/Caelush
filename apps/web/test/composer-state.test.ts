import { describe, expect, it } from "vitest";
import { shouldDisableComposerInteraction } from "../src/app.js";

describe("web composer interaction state", () => {
  it("keeps an idle workspace composer interactive before a model is selected", () => {
    expect(
      shouldDisableComposerInteraction({
        status: "READY",
        submission: "IDLE",
        activeRun: undefined,
        controlMode: "NONE",
      }),
    ).toBe(false);
  });

  it("locks the composer while a Run is active", () => {
    expect(
      shouldDisableComposerInteraction({
        status: "READY",
        submission: "ACTIVE",
        activeRun: { id: "run-1" } as never,
        controlMode: "NONE",
      }),
    ).toBe(true);
  });
});
