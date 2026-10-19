import { describe, expect, it } from "vitest";
import { shouldDisableComposerInteraction } from "../src/app.js";
import { resolveComposerCapabilities } from "../src/application/composer-state.js";

/**
 * Composer capabilities.
 *
 * The old contract was one `disabled` bit that an active Run turned on, which forced the workbench
 * to choose between "you may not type" and "your typing quietly becomes a second task". Editing,
 * starting a task, correcting the current task and stopping it are four independent decisions.
 */
describe("web composer interaction state", () => {
  it("keeps an idle workspace composer interactive before a model is selected", () => {
    const capabilities = resolveComposerCapabilities({
      status: "READY",
      submission: "IDLE",
      activeRun: undefined,
      controlMode: "NONE",
    });
    expect(capabilities).toEqual({
      editable: true,
      canSubmitNewTask: true,
      canSubmitRunInput: false,
      canStop: false,
    });
  });

  it("keeps editing, correcting and stopping available while a Run is active", () => {
    const capabilities = resolveComposerCapabilities({
      status: "READY",
      submission: "ACTIVE",
      activeRun: { id: "run-1", status: "RUNNING" },
      controlMode: "NONE",
      runInputSupported: true,
      textEmpty: false,
    });
    expect(capabilities).toEqual({
      editable: true,
      // A new task while one is running would be a second Run the user did not ask for.
      canSubmitNewTask: false,
      canSubmitRunInput: true,
      canStop: true,
    });
  });

  it("accepts corrections while paused but never claims them in a terminal Run", () => {
    for (const status of ["WAITING_APPROVAL", "WAITING_RESOURCE"] as const) {
      expect(
        resolveComposerCapabilities({
          status: "READY",
          submission: "ACTIVE",
          activeRun: { id: "run-1", status },
          controlMode: "NONE",
          runInputSupported: true,
        }).canSubmitRunInput,
      ).toBe(true);
    }
    expect(
      resolveComposerCapabilities({
        status: "READY",
        submission: "IDLE",
        activeRun: { id: "run-1", status: "COMPLETED" },
        controlMode: "NONE",
        runInputSupported: true,
      }).canSubmitRunInput,
    ).toBe(false);
  });

  it("keeps the draft editable when the daemon cannot accept mid-Run input", () => {
    const capabilities = resolveComposerCapabilities({
      status: "READY",
      submission: "ACTIVE",
      activeRun: { id: "run-1", status: "RUNNING" },
      controlMode: "NONE",
      runInputSupported: false,
    });
    expect(capabilities.editable).toBe(true);
    expect(capabilities.canSubmitRunInput).toBe(false);
    expect(capabilities.canStop).toBe(true);
  });

  it("never sends empty text and never offers a second stop while stopping", () => {
    expect(
      resolveComposerCapabilities({
        status: "READY",
        submission: "ACTIVE",
        activeRun: { id: "run-1", status: "RUNNING" },
        controlMode: "NONE",
        runInputSupported: true,
        textEmpty: true,
      }),
    ).toMatchObject({ canSubmitNewTask: false, canSubmitRunInput: false });
    expect(
      resolveComposerCapabilities({
        status: "READY",
        submission: "ACTIVE",
        activeRun: { id: "run-1", status: "RUNNING" },
        controlMode: "CANCELLING",
        runInputSupported: true,
      }),
    ).toMatchObject({ canStop: false, editable: true });
  });

  it("still blocks a new task while a permission change is being prepared", () => {
    expect(
      resolveComposerCapabilities({
        status: "READY",
        submission: "IDLE",
        activeRun: undefined,
        controlMode: "NONE",
        preparingPreset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
      }).canSubmitNewTask,
    ).toBe(false);
  });

  it("keeps the legacy predicate for callers that only ask about submitting a new task", () => {
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
