export {
  CaelushClient,
  CaelushClientHttpError,
  CaelushClientProtocolError,
  CaelushProtocolCompatibilityError,
  parseSseReader,
} from "./client.js";
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
