import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunSchema,
  createRunId,
  createSessionId,
  createTimestampMs,
  createWorkspaceId,
  type AgentRun,
  type DaemonInfo,
  type RunId,
} from "@caelush/protocol";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDaemonApp } from "../src/app.js";
import type { DaemonExecutionSurface } from "../src/routes/execution.js";
import { RunExecutionSupervisor } from "../src/execution/run-execution-supervisor.js";

/**
 * `POST /api/v1/runs/:runId/recover` over the **real** control plane.
 *
 * V1's frozen acceptance recorded a "transient HTTP 500" from this endpoint whose body was exactly
 * `{"code":"INTERNAL_ERROR","message":"An internal error occurred."}` — the error handler's
 * *fallback* branch, which only an unrecognised error class can reach. Reproducing that requires the
 * true production path: a Run decoded out of real SQLite by the real repository, projected by the
 * real `toClientAgentRun`, answered by the real `RunExecutionSupervisor`, and serialised by the real
 * response serializer.
 *
 * Two separate, evidence-backed defects both produced that identical body, and both are closed here:
 *
 * ```text
 * 1  SqliteRunRepository wrapped writes but not reads, so a torn-down generation answered a raw driver
 *    error with the anonymous fallback instead of naming the storage layer
 * 2  mapError ignored a framework error's own statusCode, so Fastify's request-parsing 4xx (an empty
 *    JSON body) was reported as the server's own fault
 * ```
 *
 * The harness half of the V1 story — a bodyless action POST that still advertised
 * `content-type: application/json` — is fixed in the `real-world-v2` harness, not in the product.
 *
 * A Run that a daemon actually produced carries the optional lifecycle fields — `resourcePolicy`,
 * `currentStepId`, `finalResult` — so those are seeded here rather than left absent.
 */

const info: DaemonInfo = {
  apiVersion: "v1",
  protocolVersion: 1,
  daemonVersion: "0.1.0",
  capabilities: {
    runExecution: true,
    runRecovery: true,
    cancellation: true,
    approvals: true,
    sseReplay: true,
  },
  runtimeKinds: ["local"],
  configuredProviders: ["test"],
  defaultModel: { provider: "test", model: "test-model" },
  defaultRunConfiguration: {
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  },
};

const RESOURCE_POLICY = {
  mode: "LEGACY_FIXED",
  operationalLease: { maxAgentTurns: 3, maxToolOperations: 3 },
  batch: { maxToolCallsPerTurn: 3 },
  progress: {
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 4,
    replansBeforePause: 2,
  },
  hardLimits: { maxAgentTurns: 3, maxToolCalls: 3, maxWallClockMs: 1_000 },
  inactivity: {},
};

let storage: CaelushStorage | undefined;
let directory: string | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A production-shaped Run, seeded through the real repository. */
function durableRun(status: AgentRun["status"], sessionId: AgentRun["sessionId"]): AgentRun {
  return AgentRunSchema.parse({
    id: createRunId(),
    sessionId,
    goal: "recover me",
    status,
    workspace: { id: createWorkspaceId(), path: "C:\\workspace" },
    model: { provider: "test", model: "test-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "READ_ONLY",
    approvalPolicy: "ALWAYS_ASK",
    limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1_000 },
    resourcePolicy: RESOURCE_POLICY,
    createdAt: createTimestampMs(1),
    ...(status === "PENDING" ? {} : { startedAt: createTimestampMs(2) }),
    ...(status === "COMPLETED"
      ? { finishedAt: createTimestampMs(3), finalResult: { kind: "TEXT", text: "done" } }
      : {}),
  });
}

async function boot(run: AgentRun) {
  directory = await mkdtemp(join(tmpdir(), "caelush-recover-"));
  storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
  await storage.sessions.insert({
    id: run.sessionId,
    createdAt: createTimestampMs(1),
    updatedAt: createTimestampMs(1),
    metadata: {},
  });
  await storage.runs.insert(run);

  // The real supervisor over the real repository. Its controller is never reached synchronously: the
  // route only enumerates and schedules, and background failures are isolated by the supervisor.
  const supervisor = new RunExecutionSupervisor({
    runs: storage.runs,
    controller: {
      start: vi.fn(async () => undefined),
      recover: vi.fn(async () => undefined),
      resolveApproval: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      continueResourceGuard: vi.fn(async () => undefined),
    },
  });
  const execution: DaemonExecutionSurface = {
    runs: storage.runs,
    supervisor,
    approvals: { listPendingByRun: (runId: RunId) => storage!.approvals.listPendingByRun(runId) },
  };

  const app = buildDaemonApp({
    sessions: storage.sessions,
    runs: storage.runs,
    eventHub: { watch: async function* () {} } as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 0 },
    execution,
    info,
  });
  return app;
}

function post(app: ReturnType<typeof buildDaemonApp>, runId: RunId) {
  return app.inject({
    method: "POST",
    url: `/api/v1/runs/${runId}/recover`,
    headers: { host: "127.0.0.1" },
  });
}

describe("recover route over the real control plane", () => {
  it("answers 202 for every non-terminal production Run shape", async () => {
    const sessionId = createSessionId();
    for (const status of ["RUNNING", "VERIFYING", "WAITING_APPROVAL", "WAITING_RESOURCE"] as const) {
      const run = durableRun(status, sessionId);
      const app = await boot(run);
      const response = await post(app, run.id);
      expect(response.statusCode, `${status}: ${response.body.slice(0, 300)}`).toBe(202);
      expect(response.json(), status).toMatchObject({ action: "RECOVER", disposition: "SCHEDULED" });
      await app.close();
    }
  });

  it("answers 200 NOOP_TERMINAL for a terminal production Run", async () => {
    const run = durableRun("COMPLETED", createSessionId());
    const app = await boot(run);
    const response = await post(app, run.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ action: "RECOVER", disposition: "NOOP_TERMINAL" });
    await app.close();
  });

  it("answers 404, never 500, for a Run that does not exist", async () => {
    const app = await boot(durableRun("RUNNING", createSessionId()));
    const response = await post(app, createRunId());
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("answers 409, never 500, for a Run that must be started rather than recovered", async () => {
    const run = durableRun("PENDING", createSessionId());
    const app = await boot(run);
    const response = await post(app, run.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    await app.close();
  });

  /**
   * The V1 recovery-500 body, reproduced on the real route and closed.
   *
   * V1's harness POSTed this endpoint with `content-type: application/json` and **no body**. Fastify's
   * JSON parser rejects that with `FST_ERR_CTP_EMPTY_JSON_BODY` — an `Error` carrying `statusCode: 400`
   * and no `validation` array — so every branch of the error handler missed it and the only reachable
   * answer was the anonymous `500 INTERNAL_ERROR "An internal error occurred."`, byte-for-byte what V1
   * recorded. The malformed request was the harness's; the misclassification was the product's — a 4xx
   * the framework had already decided was being reported as the server's own fault.
   *
   * The real CLI never sends this shape (`packages/client` sets `content-type` only when it has a body),
   * which is why the defect only ever surfaced through an external harness.
   */
  it("answers a bodyless application/json POST as 400, not as the anonymous 500", async () => {
    const run = durableRun("VERIFYING", createSessionId());
    const app = await boot(run);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${run.id}/recover`,
      headers: {
        host: "127.0.0.1",
        "content-type": "application/json",
        accept: "application/json",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    expect(response.body).not.toContain("An internal error occurred");
    // The parser's own message can quote the offending body, so it must never be echoed back.
    expect(response.body).not.toContain("Body cannot be empty");

    // The well-formed shapes for a bodyless action are unaffected.
    expect((await post(app, run.id)).statusCode).toBe(202);

    await app.close();
  });

  /**
   * The storage-classification half of the same V1 body.
   *
   * `SqliteRunRepository` wrapped its *writes* but not its *reads*, so a request that landed on a daemon
   * generation whose storage was already gone raised a raw driver error and was answered with the same
   * anonymous body. Both are closed: the read path raises a typed `StorageError`, so the control plane
   * names the failing layer instead of hiding it.
   */
  it("names the storage layer instead of the anonymous fallback when the database is gone", async () => {
    const run = durableRun("VERIFYING", createSessionId());
    const app = await boot(run);

    expect((await post(app, run.id)).statusCode).toBe(202);

    // The daemon generation loses its database — exactly the state a shutting-down instance is in.
    await storage!.close();
    storage = undefined;

    const response = await post(app, run.id);
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual(
      expect.objectContaining({ code: "STORAGE_ERROR", message: "Stored data could not be read." }),
    );
    // Never the anonymous fallback, and never the underlying driver text.
    expect(response.json().error.code).not.toBe("INTERNAL_ERROR");
    expect(response.body).not.toContain("database is not open");

    await app.close();
  });
});
