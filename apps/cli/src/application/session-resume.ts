import { resolve } from "node:path";
import {
  listMatchingSessionCandidates as listSharedSessionCandidates,
  normalizeWorkspacePath as normalizeSharedWorkspacePath,
} from "@caelush/client";
export {
  ambiguousWorkspaceError,
  deriveSessionActivity,
  hydrateSessionTranscript,
  nonTerminalRuns,
  otherWorkspaceError,
  resolveSessionWorkspace,
  sortSessionCandidates,
} from "@caelush/client";
export { MAX_SESSION_CANDIDATES, SESSION_ENRICH_CONCURRENCY } from "@caelush/client";
export type {
  SessionCandidate,
  SessionCandidateClient,
  SessionHistoryEntry,
} from "@caelush/client";
import type { SessionCandidateClient } from "@caelush/client";

export function normalizeWorkspacePath(value: string): string {
  const slashNormalized = value.replace(/[\\/]+/g, "/");
  const absolute =
    /^[A-Za-z]:\//.test(slashNormalized) || slashNormalized.startsWith("/")
      ? slashNormalized
      : resolve(slashNormalized).replace(/[\\/]+/g, "/");
  return normalizeSharedWorkspacePath(absolute);
}

export function listMatchingSessionCandidates(
  client: SessionCandidateClient,
  workspacePath: string,
) {
  return listSharedSessionCandidates(client, normalizeWorkspacePath(workspacePath));
}
