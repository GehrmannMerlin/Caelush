import type { LLMMessage } from "@caelush/llm/messages";
import { VerifiedRunFinalResultSchema, type AgentRun, type SessionId } from "@caelush/protocol";
import type { RunRepository } from "@caelush/storage";

export const MAX_SESSION_HISTORY_RUNS = 100;

export interface SessionConversationContextProviderOptions {
  readonly runs: Pick<RunRepository, "listBySession">;
  readonly maxRuns?: number;
}

export class SessionConversationContextProvider {
  private readonly maxRuns: number;

  constructor(private readonly options: SessionConversationContextProviderOptions) {
    this.maxRuns = options.maxRuns ?? MAX_SESSION_HISTORY_RUNS;
  }

  async getHistoryPrefix(currentRun: AgentRun): Promise<readonly LLMMessage[]> {
    const runs = await this.options.runs.listBySession(currentRun.sessionId, {
      limit: this.maxRuns,
    });
    const eligible = runs
      .map((run) => eligibleRun(run, currentRun))
      .filter((run): run is EligibleRun => run !== undefined)
      .sort(compareRuns)
      .slice(-this.maxRuns);

    return eligible.flatMap(({ run, finalText }) => [
      { role: "user" as const, content: run.goal },
      { role: "assistant" as const, content: [{ type: "text" as const, text: finalText }] },
    ]);
  }
}

interface EligibleRun {
  readonly run: AgentRun;
  readonly finalText: string;
}

function eligibleRun(run: AgentRun, currentRun: AgentRun): EligibleRun | undefined {
  if (run.id === currentRun.id) return undefined;
  if (run.sessionId !== currentRun.sessionId) return undefined;
  if (
    run.workspace.id !== currentRun.workspace.id ||
    run.workspace.path !== currentRun.workspace.path
  ) {
    return undefined;
  }
  if (run.status !== "COMPLETED" || run.finishedAt === undefined) return undefined;
  if (run.finishedAt > currentRun.createdAt) return undefined;
  const finalResult = VerifiedRunFinalResultSchema.safeParse(run.finalResult);
  if (!finalResult.success) return undefined;
  return { run, finalText: finalResult.data.text };
}

function compareRuns(left: EligibleRun, right: EligibleRun): number {
  if (left.run.createdAt !== right.run.createdAt) {
    return left.run.createdAt - right.run.createdAt;
  }
  return left.run.id < right.run.id ? -1 : left.run.id > right.run.id ? 1 : 0;
}
