import {
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  SessionIdSchema,
  createRunId,
  createSessionId,
  createWorkspaceId,
  type ClientAgentRun,
  type ClientAgentSession,
  type WorkspaceRef,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  deriveSessionActivity,
  listMatchingSessionCandidates,
  normalizeWorkspacePath,
  nonTerminalRuns,
  resolveSessionWorkspace,
  sortSessionCandidates,
  type SessionCandidateClient,
  type SessionCandidate,
} from "../src/application/session-resume.js";

const home = { id: createWorkspaceId(), path: "C:\\workspace\\project" };
const other = { id: createWorkspaceId(), path: "C:\\workspace\\other" };

describe("Session resume policies", () => {
  it("sorts candidates by derived activity and Session ID tie-break", () => {
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

  it("reuses the exact stored WorkspaceRef and fails on another path", () => {
    const session = makeSession(createSessionId(), home);

    expect(resolveSessionWorkspace(session, [], home.path)).toEqual({ workspace: home });
    expect(resolveSessionWorkspace(session, [], other.path)).toEqual({
      error:
        "This Session belongs to another workspace. Start Caelush from that workspace to resume it.",
    });
    expect(normalizeWorkspacePath("C:/workspace/project")).toBe(
      normalizeWorkspacePath("C:\\workspace\\project"),
    );
  });

  it("accepts a legacy Session only when every visible Run shares one identity", () => {
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

  it("derives activity from the newest Run and bounds candidate enrichment to eight calls", async () => {
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
          items: [makeRun(sessionId, { createdAt: parseInt(sessionId.slice(-12), 16) })],
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

  it("identifies only non-terminal recovery candidates", () => {
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
  const run = {
    id: createRunId(),
    sessionId: createSessionId(),
    goal,
    status: "PENDING" as const,
    workspace: home,
    runtime: { id: "local", kind: "local" as const },
    permissionProfile: "PROJECT_ACCESS" as const,
    approvalPolicy: "DANGEROUS_ONLY" as const,
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
    model: { provider: "fixture", model: "fixture-model" },
    createdAt: 1,
    ...overrides,
  };
  return ClientAgentRunSchema.parse(run);
}

function fixedSessionId(index: number) {
  return SessionIdSchema.parse(
    `ses_00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
  );
}
