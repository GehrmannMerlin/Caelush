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
  hydrateSessionTranscript,
  listMatchingSessionCandidates,
  MAX_SESSION_CANDIDATES,
  nonTerminalRuns,
  normalizeWorkspacePath,
  otherWorkspaceError,
  resolveSessionWorkspace,
  SESSION_ENRICH_CONCURRENCY,
  sortSessionCandidates,
} from "./session-projection.js";
export * from "./timeline/index.js";
export type {
  SessionCandidate,
  SessionCandidateClient,
  SessionHistoryEntry,
} from "./session-projection.js";
