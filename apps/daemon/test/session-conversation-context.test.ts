import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createStepId,
  createVerificationPlanId,
  createWorkspaceId,
  type AgentRun,
  type SessionId,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_HISTORY_RUNS,
  SessionConversationContextProvider,
} from "../src/services/session-conversation-context.js";

const sessionId = createSessionId();
const workspace = { id: createWorkspaceId(), path: "C:/workspace" };

describe("SessionConversationContextProvider", () => {
  it("projects only eligible verified Runs in deterministic chronological order", async () => {
    const older = makeCompletedRun({
      sessionId,
      createdAt: 10,
      finishedAt: 20,
      goal: "older eligible goal",
      finalText: "older verified answer",
    });
    const tieB = makeCompletedRun({
      sessionId,
      createdAt: 20,
      finishedAt: 21,
      goal: "tie B",
      finalText: "answer B",
    });
    const tieA = makeCompletedRun({
      sessionId,
      createdAt: 20,
      finishedAt: 21,
      goal: "tie A",
      finalText: "answer A",
    });
    const invalid = makeCompletedRun({
      sessionId,
      createdAt: 25,
      finishedAt: 26,
      goal: "invalid result",
      finalResult: { type: "not-verified" },
    });
    const differentWorkspace = makeCompletedRun({
      sessionId,
      workspace: { id: createWorkspaceId(), path: workspace.path },
      createdAt: 30,
      finishedAt: 31,
      goal: "different workspace",
      finalText: "do not include",
    });
    const late = makeCompletedRun({
      sessionId,
      createdAt: 35,
      finishedAt: 101,
      goal: "late finish",
      finalText: "do not include",
    });
    const failed = makeCompletedRun({
      sessionId,
      status: "FAILED",
      createdAt: 40,
      finishedAt: 41,
      goal: "failed run",
      finalText: "do not include",
    });
    const otherSession = makeCompletedRun({
      sessionId: createSessionId(),
      createdAt: 45,
      finishedAt: 46,
      goal: "different session",
      finalText: "do not include",
    });

    const provider = new SessionConversationContextProvider({
      runs: {
        listBySession: async (id: SessionId) => {
          expect(id).toBe(sessionId);
          return [late, otherSession, failed, differentWorkspace, invalid, tieB, tieA, older];
        },
      },
    });
    const history = await provider.getHistoryPrefix(makeCurrentRun({ createdAt: 100 }));

    const tieMessages = [tieA, tieB]
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((run) => [
        { role: "user" as const, content: run.goal },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: run.goal === "tie A" ? "answer A" : "answer B" },
          ],
        },
      ]);
    expect(history).toEqual([
      { role: "user", content: "older eligible goal" },
      { role: "assistant", content: [{ type: "text", text: "older verified answer" }] },
      ...tieMessages,
    ]);
    expect(history.some((message) => message.role === "tool")).toBe(false);
  });

  it("keeps only the newest bounded suffix of eligible Runs", async () => {
    const runs = Array.from({ length: MAX_SESSION_HISTORY_RUNS + 7 }, (_, index) =>
      makeCompletedRun({
        sessionId,
        createdAt: index + 1,
        finishedAt: index + 1,
        goal: `goal-${index + 1}`,
        finalText: `answer-${index + 1}`,
      }),
    );
    const provider = new SessionConversationContextProvider({
      runs: { listBySession: async () => runs },
    });

    const history = await provider.getHistoryPrefix(makeCurrentRun({ createdAt: 1000 }));

    expect(history).toHaveLength(MAX_SESSION_HISTORY_RUNS * 2);
    expect(history[0]).toEqual({ role: "user", content: "goal-8" });
    expect(history.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "answer-107" }],
    });
  });
});

function makeCurrentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return makeCompletedRun({
    sessionId,
    status: "PENDING",
    createdAt: 100,
    goal: "current goal",
    ...overrides,
  });
}

function makeCompletedRun(options: {
  sessionId: SessionId;
  workspace?: AgentRun["workspace"];
  status?: AgentRun["status"];
  createdAt: number;
  finishedAt?: number;
  goal: string;
  finalText?: string;
  finalResult?: unknown;
}): AgentRun {
  const planId = createVerificationPlanId();
  const sourceStepId = createStepId();
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId: options.sessionId,
    goal: options.goal,
    status: options.status ?? "COMPLETED",
    workspace: options.workspace ?? workspace,
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    createdAt: options.createdAt,
    ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
    ...(options.finalResult === undefined
      ? options.finalText === undefined
        ? {}
        : { finalResult: verifiedFinalResult(planId, sourceStepId, options.finalText) }
      : { finalResult: options.finalResult }),
  });
}

function verifiedFinalResult(
  planId: AgentRun["id"] extends never ? never : ReturnType<typeof createVerificationPlanId>,
  sourceStepId: ReturnType<typeof createStepId>,
  text: string,
) {
  const digest = "a".repeat(64);
  return {
    type: "VERIFIED_COMPLETION",
    text,
    verification: {
      planId,
      sourceStepId,
      planHash: digest,
      candidateHash: digest,
      evidenceDigest: digest,
      freshnessHash: digest,
      sealHash: digest,
      checks: { total: 1, passed: 1, skipped: 0, advisoryWarnings: 0 },
    },
  };
}
