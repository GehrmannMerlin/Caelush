import type { ClientAgentRun } from "@caelush/protocol";

/**
 * The composer's independent capabilities.
 *
 * ```text
 * editing        can the user type at all
 * submit         can the current text start a new task
 * steer          can the current text join the Run already in progress
 * stop           can the user stop that Run
 * ```
 *
 * They were one `disabled` flag while a Run was active, and that flag is why the workbench had to
 * choose between "you may not type" and "your typing silently becomes a second task". They are
 * separate decisions: a Run in progress never forbids editing or stopping, and it only forbids the
 * *new task* action.
 */
export interface ComposerCapabilities {
  readonly editable: boolean;
  readonly canSubmitNewTask: boolean;
  readonly canSubmitRunInput: boolean;
  readonly canStop: boolean;
}

export interface ComposerStateInput {
  readonly status: string;
  readonly submission: string;
  readonly activeRun?: Pick<ClientAgentRun, "id" | "status"> | undefined;
  readonly controlMode: string;
  readonly preparingPreset?: unknown | undefined;
  readonly archiveReadOnly?: boolean | undefined;
  /** The daemon advertises `runInputV1`; without it the workbench must not pretend to steer. */
  readonly runInputSupported?: boolean | undefined;
  readonly textEmpty?: boolean | undefined;
}

/** A Run status the workbench may still send corrections to. */
const STEERABLE_RUN_STATUSES = new Set(["RUNNING", "WAITING_APPROVAL", "WAITING_RESOURCE"]);

export function resolveComposerCapabilities(state: ComposerStateInput): ComposerCapabilities {
  const busy =
    state.archiveReadOnly === true ||
    state.status !== "READY" ||
    state.submission !== "IDLE" ||
    state.preparingPreset !== undefined ||
    state.controlMode === "CANCELLING" ||
    state.controlMode === "RECOVERY_PICKER" ||
    state.controlMode === "PENDING_RUN_CONFIRMATION";
  const activeRun = state.activeRun;
  const steerable =
    activeRun !== undefined &&
    state.runInputSupported === true &&
    STEERABLE_RUN_STATUSES.has(activeRun.status ?? "RUNNING");
  return {
    // Editing survives an active Run and a permission change; only a session that is not loaded at
    // all (or an archived read-only view) blocks typing.
    editable: state.archiveReadOnly !== true && state.status === "READY",
    canSubmitNewTask: !busy && activeRun === undefined && state.textEmpty !== true,
    canSubmitRunInput: steerable && state.textEmpty !== true,
    canStop: activeRun !== undefined && state.controlMode !== "CANCELLING",
  };
}
