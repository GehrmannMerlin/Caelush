import {
  createRunId,
  type AgentRun,
  type ApprovalRequest,
  type DaemonInfo,
  type RunId,
} from "@caelush/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDaemonApp } from "../src/app.js";
import type { DaemonExecutionSurface } from "../src/routes/execution.js";
import {
  RunExecutionSupervisorConflictError,
  RunExecutionSupervisorInfrastructureError,
  type RunExecutionSupervisorResult,
} from "../src/execution/run-execution-supervisor.js";
import { StorageNotFoundError } from "@caelush/storage";

const currentRun: AgentRun = {
  id: createRunId(),
  sessionId: "ses_00000000-0000-7000-8000-000000000000",
  goal: "test",
  status: "PENDING",
  workspace: { id: "wsp_00000000-0000-7000-8000-000000000000", path: "C:/workspace" },
  model: { provider: "test", model: "test-model" },
  runtime: { id: "local", kind: "local" },
  permissionProfile: "READ_ONLY",
  approvalPolicy: "ALWAYS_ASK",
  limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1_000 },
  createdAt: 1_700_000_000_000,
};

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

const approval: ApprovalRequest = {
  id: "apr_00000000-0000-7000-8000-000000000000",
  runId: currentRun.id,
  toolInvocationId: "tinv_00000000-0000-7000-8000-000000000000",
  riskLevel: "MEDIUM",
  title: "Approve test",
  reason: "test",
  action: { summary: "test" },
  status: "PENDING",
  scope: "ONCE",
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_000_001_000,
};

function result(
  action: RunExecutionSupervisorResult["action"],
  disposition: RunExecutionSupervisorResult["disposition"] = "SCHEDULED",
) {
  return { runId: currentRun.id, action, disposition, run: currentRun };
}

function makeSurface(): DaemonExecutionSurface {
  return {
    runs: { get: vi.fn(async (runId: RunId) => (runId === currentRun.id ? currentRun : null)) },
    supervisor: {
      start: vi.fn(async () => result("START")),
      recover: vi.fn(async () => result("RECOVER")),
      cancel: vi.fn(async () => result("CANCEL", "SETTLED")),
      resolveApproval: vi.fn(async () => result("RESOLVE_APPROVAL")),
    },
    approvals: {
      listPendingByRun: vi.fn(async (runId: RunId) => (runId === currentRun.id ? [approval] : [])),
    },
  };
}

function makeApp(surface: DaemonExecutionSurface) {
  return buildDaemonApp({
    sessions: {} as never,
    runs: { get: vi.fn(async () => currentRun) } as never,
    eventBus: {} as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 0 },
    execution: surface,
    info,
  });
}

describe("daemon execution routes", () => {
  let app: ReturnType<typeof makeApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("serves a strict info handshake without provider secrets", async () => {
    app = makeApp(makeSurface());
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/info",
      headers: { host: "127.0.0.1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(info);
    expect(response.body).not.toContain("apiKey");
    expect(response.body).not.toContain("baseUrl");
  });

  it("uses 202 action responses and delegates to the supervisor", async () => {
    const surface = makeSurface();
    app = makeApp(surface);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${currentRun.id}/start`,
      headers: { host: "127.0.0.1" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ action: "START", disposition: "SCHEDULED" });
    expect(surface.supervisor.start).toHaveBeenCalledWith(currentRun.id);
  });

  it("routes recover, cancel, approval list, and approval resolve", async () => {
    const surface = makeSurface();
    app = makeApp(surface);
    const recover = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${currentRun.id}/recover`,
      headers: { host: "127.0.0.1" },
    });
    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${currentRun.id}/cancel`,
      headers: { host: "127.0.0.1" },
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${currentRun.id}/approvals?status=PENDING`,
      headers: { host: "127.0.0.1" },
    });
    const resolve = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${currentRun.id}/approvals/${approval.id}/resolve`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { action: "APPROVE", scope: "ONCE" },
    });
    expect(recover.statusCode).toBe(202);
    expect(cancel.statusCode).toBe(200);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [approval] });
    expect(resolve.statusCode).toBe(202);
    expect(surface.supervisor.recover).toHaveBeenCalledWith(currentRun.id);
    expect(surface.supervisor.cancel).toHaveBeenCalledWith(currentRun.id);
    expect(surface.supervisor.resolveApproval).toHaveBeenCalledWith(currentRun.id, approval.id, {
      action: "APPROVE",
      scope: "ONCE",
    });
  });

  it("rejects an invalid approval body before calling the supervisor", async () => {
    const surface = makeSurface();
    app = makeApp(surface);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${currentRun.id}/approvals/${approval.id}/resolve`,
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      payload: { action: "APPROVE", scope: "RUN", extra: true },
    });
    expect(response.statusCode).toBe(400);
    expect(surface.supervisor.resolveApproval).not.toHaveBeenCalled();
  });

  it("maps unknown resources, state conflicts, and infrastructure failures safely", async () => {
    const unknownSurface = makeSurface();
    vi.mocked(unknownSurface.supervisor.start).mockRejectedValue(
      new StorageNotFoundError("AgentRun", currentRun.id),
    );
    app = makeApp(unknownSurface);
    const unknown = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${currentRun.id}/start`,
      headers: { host: "127.0.0.1" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toMatchObject({ code: "NOT_FOUND" });
    await app.close();

    const conflictSurface = makeSurface();
    vi.mocked(conflictSurface.supervisor.start).mockRejectedValue(
      new RunExecutionSupervisorConflictError("invalid state"),
    );
    app = makeApp(conflictSurface);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${currentRun.id}/start`,
      headers: { host: "127.0.0.1" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({ code: "CONFLICT" });
    await app.close();

    const approvalApp = makeApp(makeSurface());
    const unknownApproval = await approvalApp.inject({
      method: "GET",
      url: `/api/v1/runs/${createRunId()}/approvals?status=PENDING`,
      headers: { host: "127.0.0.1" },
    });
    expect(unknownApproval.statusCode).toBe(404);
    await approvalApp.close();

    const infrastructureSurface = makeSurface();
    vi.mocked(infrastructureSurface.supervisor.start).mockRejectedValue(
      new RunExecutionSupervisorInfrastructureError("private provider failure"),
    );
    app = makeApp(infrastructureSurface);
    const infrastructure = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${currentRun.id}/start`,
      headers: { host: "127.0.0.1" },
    });
    expect(infrastructure.statusCode).toBe(500);
    expect(infrastructure.body).not.toContain("private provider failure");
    expect(infrastructure.json().error.code).toBe("INTERNAL_ERROR");
  });
});
