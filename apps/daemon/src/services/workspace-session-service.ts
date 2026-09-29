import type {
  AgentRun,
  AgentSession,
  WorkspaceId,
  WorkspaceSessionSummary,
} from "@caelush/protocol";
import { TimestampMsSchema } from "@caelush/protocol";
import type { RunRepository, SessionRepository } from "@caelush/storage";
import { toClientAgentRun, toClientAgentSession } from "./public-projection.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";

export interface WorkspaceSessionServiceOptions {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly workspaceService: WorkspaceService;
}

export class WorkspaceSessionService {
  constructor(private readonly options: WorkspaceSessionServiceOptions) {}

  async listSessions(workspaceId: WorkspaceId, limit: number): Promise<WorkspaceSessionSummary[]> {
    await this.options.workspaceService.requireWorkspace(workspaceId);
    const sessions = await this.options.sessions.listByWorkspace(workspaceId);
    const summaries = await Promise.all(sessions.map((session) => this.toSummary(session)));
    summaries.sort((left, right) => {
      if (right.lastActivityAt !== left.lastActivityAt) {
        return right.lastActivityAt - left.lastActivityAt;
      }
      return left.session.id.localeCompare(right.session.id);
    });
    return summaries.slice(0, Math.max(0, Math.floor(limit)));
  }

  private async toSummary(session: AgentSession): Promise<WorkspaceSessionSummary> {
    const runs = await this.options.runs.listBySession(session.id);
    const latestRun = latestByActivity(runs);
    const lastActivityAt = Math.max(session.updatedAt, latestRun === undefined ? 0 : runActivityAt(latestRun));
    return {
      session: toClientAgentSession(session),
      lastActivityAt: TimestampMsSchema.parse(lastActivityAt),
      ...(latestRun === undefined ? {} : { latestRun: toClientAgentRun(latestRun) }),
    };
  }
}

function latestByActivity(runs: readonly AgentRun[]): AgentRun | undefined {
  return runs.reduce<AgentRun | undefined>((latest, run) => {
    if (latest === undefined) return run;
    const activity = runActivityAt(run);
    const latestActivity = runActivityAt(latest);
    if (activity > latestActivity || (activity === latestActivity && run.id < latest.id)) {
      return run;
    }
    return latest;
  }, undefined);
}

function runActivityAt(run: AgentRun): number {
  return run.finishedAt ?? run.startedAt ?? run.createdAt;
}
