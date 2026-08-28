import {
  AgentRunSchema,
  createRunId,
  type AgentRun,
  type CreateRunRequest,
  type RunId,
  type RunListQuery,
  type SessionId,
} from "@caelush/protocol";
import { StorageNotFoundError, type RunRepository, type SessionRepository } from "@caelush/storage";

export interface RunServiceOptions {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly now?: () => number;
  readonly createId?: typeof createRunId;
}

export class RunService {
  private readonly now: () => number;
  private readonly createId: typeof createRunId;

  constructor(private readonly options: RunServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? createRunId;
  }

  async createRun(sessionId: SessionId, input: CreateRunRequest): Promise<AgentRun> {
    await this.requireSession(sessionId);
    const run = AgentRunSchema.parse({
      id: this.createId(),
      sessionId,
      ...input,
      status: "PENDING",
      createdAt: this.now(),
    });
    await this.options.runs.insert(run);
    return run;
  }

  async getRun(id: RunId): Promise<AgentRun> {
    const run = await this.options.runs.get(id);
    if (!run) throw new StorageNotFoundError("AgentRun", id);
    return run;
  }

  async listRuns(sessionId: SessionId, query: RunListQuery): Promise<AgentRun[]> {
    await this.requireSession(sessionId);
    const options =
      query.status === undefined
        ? { limit: query.limit }
        : { limit: query.limit, status: query.status };
    return this.options.runs.listBySession(sessionId, options);
  }

  private async requireSession(sessionId: SessionId): Promise<void> {
    if (!(await this.options.sessions.get(sessionId))) {
      throw new StorageNotFoundError("AgentSession", sessionId);
    }
  }
}
