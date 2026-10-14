import { createSessionId, createWorkspaceId, type DurableRunEvent } from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { RunService } from "../src/services/run-service.js";
import { SecurityCapabilityService } from "../src/services/security-capability-service.js";

function makeCapabilities() {
  return new SecurityCapabilityService({
    processSandboxProviders: [
      {
        id: "fixture-restricted",
        kind: "RESTRICTED",
        enforcement: "HARD",
        create: vi.fn(),
        probe: async () => ({ available: true, enforcement: "HARD" }),
      },
    ],
    fullAccessAvailable: true,
  });
}

function makeInput() {
  return {
    goal: "Inspect the workspace",
    workspace: { id: createWorkspaceId(), path: "C:/workspace" },
    model: { provider: "fixture", model: "fixture-model" },
    runtime: { id: "local", kind: "local" },
    preset: { id: "WORKSPACE_WRITE" as const, expectedVersion: 1 },
    limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 1_000 },
  };
}

describe("RunService security policy binding", () => {
  it("expands only the server catalog and atomically binds the policy event to a PENDING Run", async () => {
    const sessionId = createSessionId();
    const contextBudgetPolicy = {
      version: "ADAPTIVE_V1" as const,
      outputReserveTokens: 16_384,
      safetyReserveTokens: 4_096,
    };
    const contextBudgetPolicyResolver = {
      resolve: vi.fn(async () => contextBudgetPolicy),
    };
    const inserted: { run: unknown; events: readonly unknown[] }[] = [];
    const committedEvent = {
      eventId: "evt_00000000-0000-7000-8000-000000000000",
      schemaVersion: 1,
      runId: "run_00000000-0000-7000-8000-000000000000",
      sessionId,
      timestamp: 1_700_000_000_000,
      visibility: "USER_VISIBLE",
      type: "run.security_policy.bound",
      payload: {},
      durability: { kind: "DURABLE", version: 1, sequence: 1 },
    } as unknown as DurableRunEvent;
    const runs = {
      insertWithEvents: vi.fn(async (run: unknown, events: readonly unknown[]) => {
        inserted.push({ run, events });
        return [committedEvent];
      }),
      get: vi.fn(),
      listBySession: vi.fn(),
    };
    const events = { notifyCommitted: vi.fn() };
    const service = new RunService({
      sessions: { get: vi.fn(async () => ({ id: sessionId, defaultModel: undefined })) } as never,
      runs: runs as never,
      securityCapabilityService: makeCapabilities(),
      contextBudgetPolicyResolver,
      eventNotifier: events,
      now: () => 1_700_000_000_000,
      createId: () => "run_00000000-0000-7000-8000-000000000000" as never,
    });

    const run = await service.createRun(sessionId, makeInput());

    expect(run).toMatchObject({
      status: "PENDING",
      permissionProfile: "PROJECT_ACCESS",
      approvalPolicy: "ON_BOUNDARY",
      securityPolicy: {
        preset: { id: "WORKSPACE_WRITE", version: 1 },
        filesystemBoundary: "WORKSPACE_READ_WRITE",
        processBoundary: "WORKSPACE_WRITE",
      },
      contextBudgetPolicy,
    });
    expect(inserted).toHaveLength(1);
    expect(contextBudgetPolicyResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider: "fixture", model: "fixture-model" },
        status: "PENDING",
      }),
    );
    expect(inserted[0]?.events).toHaveLength(1);
    expect(inserted[0]?.run).toMatchObject({ contextBudgetPolicy });
    expect(inserted[0]?.events[0]).toMatchObject({
      type: "run.security_policy.bound",
      payload: {
        preset: { id: "WORKSPACE_WRITE", version: 1 },
        policyDigest: run.securityPolicy?.policyDigest,
      },
    });
    expect(events.notifyCommitted).toHaveBeenCalledWith([committedEvent]);
  });

  it("does not create a Run or event when context budget policy resolution fails", async () => {
    const sessionId = createSessionId();
    const runs = { insertWithEvents: vi.fn(async () => []) };
    const events = { notifyCommitted: vi.fn() };
    const service = new RunService({
      sessions: { get: vi.fn(async () => ({ id: sessionId, defaultModel: undefined })) } as never,
      runs: runs as never,
      securityCapabilityService: makeCapabilities(),
      contextBudgetPolicyResolver: {
        resolve: vi.fn(async () => {
          throw new Error("model budget unavailable");
        }),
      },
      eventNotifier: events,
    });

    await expect(service.createRun(sessionId, makeInput())).rejects.toThrow(
      "model budget unavailable",
    );
    expect(runs.insertWithEvents).not.toHaveBeenCalled();
    expect(events.notifyCommitted).not.toHaveBeenCalled();
  });

  it("fails closed for an unavailable preset instead of silently changing authority", async () => {
    const service = new RunService({
      sessions: { get: vi.fn(async () => ({ id: createSessionId() })) } as never,
      runs: { insert: vi.fn() } as never,
      securityCapabilityService: new SecurityCapabilityService({
        processSandboxProviders: [],
        fullAccessAvailable: false,
      }),
    });

    await expect(
      service.createRun(createSessionId(), {
        ...makeInput(),
        preset: { id: "VIEW_ONLY", expectedVersion: 1 },
      }),
    ).rejects.toThrow();
  });
});
