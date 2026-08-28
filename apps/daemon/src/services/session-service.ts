import {
  AgentSessionSchema,
  createSessionId,
  type AgentSession,
  type CreateSessionRequest,
  type SessionId,
} from "@caelush/protocol";
import type { SessionRepository } from "@caelush/storage";
import { StorageNotFoundError } from "@caelush/storage";

export interface SessionServiceOptions {
  readonly repository: SessionRepository;
  readonly now?: () => number;
  readonly createId?: typeof createSessionId;
}

export class SessionService {
  private readonly now: () => number;
  private readonly createId: typeof createSessionId;

  constructor(private readonly options: SessionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? createSessionId;
  }

  async createSession(input: CreateSessionRequest): Promise<AgentSession> {
    const timestamp = this.now();
    const session = AgentSessionSchema.parse({
      id: this.createId(),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.defaultWorkspace === undefined ? {} : { defaultWorkspace: input.defaultWorkspace }),
      ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel }),
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: input.metadata ?? {},
    });
    await this.options.repository.insert(session);
    return session;
  }

  async getSession(id: SessionId): Promise<AgentSession> {
    const session = await this.options.repository.get(id);
    if (!session) throw new StorageNotFoundError("AgentSession", id);
    return session;
  }

  async listSessions(limit: number): Promise<AgentSession[]> {
    return this.options.repository.list({ limit });
  }
}
