import {
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  SessionIdSchema,
  VerifiedRunFinalResultSchema,
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createVerificationPlanId,
  createWorkspaceId,
  type ClientAgentRun,
  type ClientAgentSession,
  type WorkspaceRef,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  deriveSessionActivity,
  hydrateSessionTranscript,
  listMatchingSessionCandidates,
  nonTerminalRuns,
  normalizeWorkspacePath,
  resolveSessionWorkspace,
  sortSessionCandidates,
  type SessionCandidate,
  type SessionCandidateClient,
} from "../src/session-projection.js";

const home = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
const other = { id: createWorkspaceId(), path: "C:\\workspace\\other" };

describe("browser-safe Session projection", () => {
  it("normalizes Windows path spelling without Node APIs", () => {
    expect(normalizeWorkspacePath("C:/workspace/project/")).toBe("c:/workspace/project");
    expect(normalizeWorkspacePath("C:\\workspace\\project")).toBe("c:/workspace/project");
    expect(normalizeWorkspacePath("C:\\")).toBe("c:/");
  });

  it("sorts candidates by activity and deterministic Session ID tie-break", () => {
    const candidates: SessionCandidate[] = [
      { session: makeSession(fixedSessionId(2)), lastActivityAt: 10 },
      { session: makeSession(fixedSessionId(1)), lastActivityAt: 10 },
      { session: makeSession(fixedSessionId(3)), lastActivityAt: 9 },
    ];

    expect(sortSessionCandidates(candidates).map((item) => item.session.id)).toEqual([
      fixedSessionId(1),
      fixedSessionId(2),
      fixedSessionId(3),
    ]);
  });

  it("filters Sessions by workspace and bounds latest-Run enrichment", async () => {
    const sessions = Array.from({ length: 100 }, (_, index) =>
      makeSession(fixedSessionId(index + 1), index % 2 === 0 ? home : other),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const client: SessionCandidateClient = {
      listSessions: async (query) => {
        expect(query).toEqual({ limit: 100 });
        return { items: sessions };
      },
      listRuns: async (sessionId, query) => {
        expect(query).toEqual({ limit: 1 });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return {
          items: [
            makeRun(sessionId, {
              createdAt: createTimestampMs(parseInt(sessionId.slice(-12), 16)),
            }),
          ],
        };
      },
    };

    const candidates = await listMatchingSessionCandidates(client, home.path);

    expect(candidates).toHaveLength(50);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(deriveSessionActivity(candidates[0]!.session, candidates[0]!.latestRun)).toBe(
      candidates[0]!.lastActivityAt,
    );
  });

  it("resolves a stored workspace and rejects another workspace", () => {
    const session = makeSession(createSessionId(), home);

    expect(resolveSessionWorkspace(session, [], home.path)).toEqual({ workspace: home });
    expect(resolveSessionWorkspace(session, [], other.path)).toEqual({
      error:
        "This Session belongs to another workspace. Start Caelush from that workspace to resume it.",
    });
  });

  it("accepts a legacy Session only when visible Runs share one workspace", () => {
    const session = makeSession();
    const one = makeRun("one", { workspace: home });
    const two = makeRun("two", { workspace: home });
    const ambiguous = makeRun("other", { workspace: other });

    expect(resolveSessionWorkspace(session, [one, two], home.path)).toEqual({ workspace: home });
    expect(resolveSessionWorkspace(session, [], home.path)).toEqual({
      error: "Session cannot be resumed safely because its workspace identity is ambiguous.",
    });
    expect(resolveSessionWorkspace(session, [one, ambiguous], home.path)).toEqual({
      error: "Session cannot be resumed safely because its workspace identity is ambiguous.",
    });
  });

  it("hydrates only Run-level public history and shows a verified result", () => {
    const failed = makeRun("first", {
      status: "FAILED",
      createdAt: createTimestampMs(1),
      finishedAt: createTimestampMs(2),
    });
    const completed = makeRun("second", {
      status: "COMPLETED",
      createdAt: createTimestampMs(2),
      finishedAt: createTimestampMs(3),
      finalResult: verifiedFinalResult("answer 2"),
    });
    const active = makeRun("active", {
      status: "RUNNING",
      createdAt: createTimestampMs(3),
      startedAt: createTimestampMs(4),
    });

    expect(hydrateSessionTranscript([completed, active, failed], active.id)).toMatchObject([
      { kind: "USER", text: "first" },
      { kind: "RUN_TERMINAL", text: "Run ended with status FAILED." },
      { kind: "USER", text: "second" },
      { kind: "ASSISTANT", text: "answer 2" },
      { kind: "USER", text: "active" },
    ]);
    expect(JSON.stringify(hydrateSessionTranscript([active], active.id))).not.toContain(
      "workspace",
    );
  });

  it("marks a completed Run without a valid result as terminal rather than an answer", () => {
    const completed = makeRun("without result", { status: "COMPLETED" });

    expect(hydrateSessionTranscript([completed])).toMatchObject([
      { kind: "USER", text: "without result" },
      { kind: "RUN_TERMINAL", text: "Run completed without a verified final result." },
    ]);
  });

  it("identifies only non-terminal Run statuses", () => {
    const runs = [
      makeRun("pending", { status: "PENDING" }),
      makeRun("running", { status: "RUNNING" }),
      makeRun("approval", { status: "WAITING_APPROVAL" }),
      makeRun("verify", { status: "VERIFYING" }),
      makeRun("done", { status: "COMPLETED" }),
    ];

    expect(nonTerminalRuns(runs).map((run) => run.goal)).toEqual([
      "pending",
      "running",
      "approval",
      "verify",
    ]);
  });
});

function makeSession(id = createSessionId(), defaultWorkspace?: WorkspaceRef): ClientAgentSession {
  return ClientAgentSessionSchema.parse({
    id,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
    ...(defaultWorkspace === undefined ? {} : { defaultWorkspace }),
  });
}

function makeRun(goal: string, overrides: Partial<ClientAgentRun> = {}): ClientAgentRun {
  return ClientAgentRunSchema.parse({
    id: createRunId(),
    sessionId: createSessionId(),
    goal,
    status: "PENDING",
    workspace: home,
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    model: { provider: "fixture", model: "fixture-model" },
    createdAt: 1,
    ...overrides,
  });
}

function verifiedFinalResult(text: string) {
  return VerifiedRunFinalResultSchema.parse({
    type: "VERIFIED_COMPLETION",
    text,
    verification: {
      planId: createVerificationPlanId(),
      sourceStepId: createStepId(),
      planHash: "a".repeat(64),
      candidateHash: "b".repeat(64),
      evidenceDigest: "c".repeat(64),
      freshnessHash: "d".repeat(64),
      sealHash: "e".repeat(64),
      checks: { total: 1, passed: 1, skipped: 0, advisoryWarnings: 0 },
    },
  });
}

function fixedSessionId(index: number) {
  return SessionIdSchema.parse(
    `ses_00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
  );
}
