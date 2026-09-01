import type {
  ClientAgentRun,
  ClientAgentSession,
  DaemonInfo,
  RunId,
  RunStatus,
  WorkspaceRef,
} from "@caelush/protocol";
import type {
  CliApprovalState,
  CliControlMode,
  CliTransportState,
} from "./cli-control.js";
import type { SessionCandidate } from "./session-resume.js";
import {
  createInitialCliTimelineState,
  type CliTimelineEntry,
  type CliTimelineState,
} from "./timeline-model.js";

export type CliBootstrapState =
  | "STARTING"
  | "CONNECTING"
  | "CHECKING_COMPATIBILITY"
  | "CREATING_SESSION"
  | "READY"
  | "BOOTSTRAP_ERROR";

export type CliActivity =
  | "Starting"
  | "Connecting"
  | "Checking compatibility"
  | "Creating session"
  | "Ready"
  | "Preparing"
  | "Working"
  | "Retrying"
  | "Verifying"
  | "Approval required"
  | "Transport error"
  | "Completed"
  | "Failed"
  | "Cancelled"
  | "Timed out"
  | "Max steps reached"
  | "Budget exceeded"
  | "Terminal error";

export interface CliTranscriptEntry {
  readonly id: string;
  readonly kind: "USER" | "ASSISTANT" | "RUN_TERMINAL";
  readonly text: string;
  readonly runId?: RunId;
}

export type CliDisplayHistoryEntry = CliTranscriptEntry | CliTimelineEntry;

export interface CliActiveRun {
  readonly runId: RunId;
  readonly status: RunStatus;
}

export interface CliViewState {
  readonly bootstrap: CliBootstrapState;
  readonly transportState: CliTransportState;
  readonly controlMode: CliControlMode;
  readonly workspace?: WorkspaceRef;
  readonly daemonInfo?: DaemonInfo;
  readonly session?: ClientAgentSession;
  readonly sessionCandidates: readonly SessionCandidate[];
  readonly recoveryCandidates: readonly ClientAgentRun[];
  readonly approvalState?: CliApprovalState;
  readonly pendingRunId?: RunId;
  readonly displayHistory: readonly CliDisplayHistoryEntry[];
  readonly timeline: CliTimelineState;
  readonly activeRun?: CliActiveRun;
  readonly composerEnabled: boolean;
  readonly activity: CliActivity;
  readonly notice?: string;
  readonly controlError?: string;
  readonly transportError?: string;
  readonly fatalError?: string;
}

export type CliStateListener = (state: CliViewState) => void;

export function createInitialCliState(): CliViewState {
  return {
    bootstrap: "STARTING",
    transportState: "CONNECTED",
    controlMode: "NONE",
    sessionCandidates: [],
    recoveryCandidates: [],
    displayHistory: [],
    timeline: createInitialCliTimelineState(),
    composerEnabled: false,
    activity: "Starting",
  };
}
