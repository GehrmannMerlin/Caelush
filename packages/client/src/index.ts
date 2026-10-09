export {
  CaelushClient,
  CaelushClientHttpError,
  CaelushClientProtocolError,
  CaelushProtocolCompatibilityError,
  parseSseReader,
} from "./client.js";
export {
  DESKTOP_DAEMON_API_VERSION,
  DESKTOP_DAEMON_PROTOCOL_VERSION,
  DESKTOP_HOST_CAPABILITIES,
  IMPLEMENTED_DESKTOP_HOST_CAPABILITIES,
  evaluateDesktopDaemonCompatibility,
} from "./desktop-compatibility.js";
export type {
  DesktopCompatibilityErrorCode,
  DesktopCompatibilityRequirements,
  DesktopCompatibleResult,
  DesktopDaemonCompatibility,
  DesktopDaemonCapability,
  DesktopHostCapability,
  DesktopIncompatibleResult,
} from "./desktop-compatibility.js";
export type {
  CaelushClientOptions,
  CaelushClientRequestOptions,
  WatchRunEventsOptions,
} from "./client.js";
export {
  ambiguousWorkspaceError,
  deriveSessionActivity,
  listMatchingSessionCandidates,
  MAX_SESSION_CANDIDATES,
  nonTerminalRuns,
  normalizeWorkspacePath,
  otherWorkspaceError,
  reconcileSessionTranscript,
  resolveSessionWorkspace,
  SESSION_ENRICH_CONCURRENCY,
  sortSessionCandidates,
} from "./session-projection.js";
export * from "./timeline/index.js";
export * from "./control/index.js";
export type {
  SessionCandidate,
  SessionCandidateClient,
  TranscriptEntry,
} from "./session-projection.js";
export {
  createInitialLiveActivityState,
  pruneProjectedLiveActivities,
  reduceLiveActivityEvent,
} from "./live-activity.js";
export type {
  LiveActivity,
  LiveActivityKind,
  LiveActivityState,
  LiveActivityStatus,
  ModelWaitPhase,
  ModelWaitState,
} from "./live-activity.js";
