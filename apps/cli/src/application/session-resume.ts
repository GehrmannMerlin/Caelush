import { resolve } from "node:path";
import {
  VerifiedRunFinalResultSchema,
  type ClientAgentRun,
  type ClientAgentSession,
  type RunId,
  type RunListQuery,
  type RunListResponse,
  type SessionListQuery,
  type SessionListResponse,
  type SessionId,
  type WorkspaceRef,
} from "@caelush/protocol";
import type { CliTranscriptEntry } from "./cli-state.js";

export const MAX_SESSION_CANDIDATES = 100;
export const SESSION_ENRICH_CONCURRENCY = 8;

export interface SessionCandidateClient {
  listSessions(query?: Partial<SessionListQuery>): Promise<SessionListResponse>;
  listRuns(sessionId: SessionId, query?: Partial<RunListQuery>): Promise<RunListResponse>;
}

export interface SessionCandidate {
  readonly session: ClientAgentSession;
  readonly latestRun?: ClientAgentRun;
  readonly lastActivityAt: number;
}

export function normalizeWorkspacePath(value: string): string {
  const slashNormalized = value.replace(/[\\/]+/g, "/");
  const absolute = isAbsolutePath(slashNormalized)
    ? slashNormalized
    : resolve(slashNormalized).replace(/[\\/]+/g, "/");
  const withoutTrailingSlash = absolute.length > 1 ? absolute.replace(/\/$/, "") : absolute;
  return process.platform === "win32" ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
}

export function deriveSessionActivity(
  session: ClientAgentSession,
  latestRun: ClientAgentRun | undefined,
): number {
  return (
    latestRun?.finishedAt ??
    latestRun?.startedAt ??
    latestRun?.createdAt ??
    session.updatedAt
  );
}

export function sortSessionCandidates(
  candidates: readonly SessionCandidate[],
): readonly SessionCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.lastActivityAt !== right.lastActivityAt) {
      return right.lastActivityAt - left.lastActivityAt;
    }
    return left.session.id < right.session.id ? -1 : left.session.id > right.session.id ? 1 : 0;
  });
}

export async function listMatchingSessionCandidates(
  client: SessionCandidateClient,
  workspacePath: string,
): Promise<readonly SessionCandidate[]> {
  const sessions = (await client.listSessions({ limit: MAX_SESSION_CANDIDATES })).items;
  const currentPath = normalizeWorkspacePath(workspacePath);
  const candidates: SessionCandidate[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const session = sessions[index];
      if (session === undefined) return;
      const latestRun = (await client.listRuns(session.id, { limit: 1 })).items[0];
      const candidatePath = session.defaultWorkspace?.path ?? latestRun?.workspace.path;
      if (candidatePath === undefined || normalizeWorkspacePath(candidatePath) !== currentPath) {
        continue;
      }
      candidates.push({
        session,
        ...(latestRun === undefined ? {} : { latestRun }),
        lastActivityAt: deriveSessionActivity(session, latestRun),
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SESSION_ENRICH_CONCURRENCY, sessions.length) }, () => worker()),
  );
  return sortSessionCandidates(candidates);
}

export function resolveSessionWorkspace(
  session: ClientAgentSession,
  visibleRuns: readonly ClientAgentRun[],
  currentWorkspacePath: string,
): { readonly workspace: WorkspaceRef } | { readonly error: string } {
  const currentPath = normalizeWorkspacePath(currentWorkspacePath);
  if (session.defaultWorkspace !== undefined) {
    return normalizeWorkspacePath(session.defaultWorkspace.path) === currentPath
      ? { workspace: session.defaultWorkspace }
      : { error: otherWorkspaceError() };
  }

  const identities = new Map<string, WorkspaceRef>();
  for (const run of visibleRuns) {
    const key = `${run.workspace.id}:${normalizeWorkspacePath(run.workspace.path)}`;
    identities.set(key, run.workspace);
  }
  if (identities.size !== 1) return { error: ambiguousWorkspaceError() };
  const workspace = identities.values().next().value as WorkspaceRef | undefined;
  return workspace !== undefined && normalizeWorkspacePath(workspace.path) === currentPath
    ? { workspace }
    : { error: otherWorkspaceError() };
}

export function hydrateSessionTranscript(
  runs: readonly ClientAgentRun[],
  activeRunId?: RunId,
): readonly CliTranscriptEntry[] {
  const history: CliTranscriptEntry[] = [];
  const ordered = [...runs].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  for (const run of ordered) {
    history.push({ id: `history:user:${run.id}`, kind: "USER", text: run.goal, runId: run.id });
    if (run.status === "COMPLETED") {
      const finalResult = VerifiedRunFinalResultSchema.safeParse(run.finalResult);
      history.push(
        finalResult.success
          ? {
              id: `history:assistant:${run.id}`,
              kind: "ASSISTANT",
              text: finalResult.data.text,
              runId: run.id,
            }
          : {
              id: `history:terminal:${run.id}`,
              kind: "RUN_TERMINAL",
              text: "Run completed without a verified final result.",
              runId: run.id,
            },
      );
    } else if (isTerminalRun(run)) {
      history.push({
        id: `history:terminal:${run.id}`,
        kind: "RUN_TERMINAL",
        text: `Run ended with status ${run.status}.`,
        runId: run.id,
      });
    }
  }

  if (activeRunId === undefined) return history;
  const activeGoalEntries = history.filter(
    (entry) => entry.kind === "USER" && entry.runId === activeRunId,
  );
  return activeGoalEntries.length <= 1 ? history : deduplicateActiveGoal(history, activeRunId);
}

export function nonTerminalRuns(runs: readonly ClientAgentRun[]): readonly ClientAgentRun[] {
  return runs.filter((run) =>
    (["PENDING", "RUNNING", "WAITING_APPROVAL", "VERIFYING"] as const).includes(run.status),
  );
}

export function otherWorkspaceError(): string {
  return "This Session belongs to another workspace. Start Caelush from that workspace to resume it.";
}

export function ambiguousWorkspaceError(): string {
  return "Session cannot be resumed safely because its workspace identity is ambiguous.";
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function isTerminalRun(run: ClientAgentRun): boolean {
  return (
    run.status === "FAILED" ||
    run.status === "CANCELLED" ||
    run.status === "TIMEOUT" ||
    run.status === "MAX_STEPS_REACHED" ||
    run.status === "BUDGET_EXCEEDED"
  );
}

function deduplicateActiveGoal(
  history: readonly CliTranscriptEntry[],
  activeRunId: RunId,
): readonly CliTranscriptEntry[] {
  let retained = false;
  return history.filter((entry) => {
    if (entry.kind !== "USER" || entry.runId !== activeRunId) return true;
    if (retained) return false;
    retained = true;
    return true;
  });
}
