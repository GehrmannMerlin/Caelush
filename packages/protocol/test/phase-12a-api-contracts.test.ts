import {
  AgentRunSchema,
  AgentSessionSchema,
  ApprovalListResponseSchema,
  ApprovalResolutionSchema,
  ClientAgentRunSchema,
  ClientAgentSessionSchema,
  ClientModelSelectionSchema,
  CreateRunRequestSchema,
  CreateSessionRequestSchema,
  DaemonInfoSchema,
  RunActionResponseSchema,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";

const baseRun = {
  id: "run_00000000-0000-7000-8000-000000000000",
  sessionId: "ses_00000000-0000-7000-8000-000000000000",
  goal: "Inspect the project",
  status: "PENDING" as const,
  workspace: { id: "wsp_00000000-0000-7000-8000-000000000000", path: "C:/workspace" },
  model: { provider: "openai", model: "gpt-5.4", baseUrl: "https://provider.invalid/v1" },
  runtime: { id: "local", kind: "local" },
  permissionProfile: "READ_ONLY" as const,
  approvalPolicy: "ALWAYS_ASK" as const,
  limits: { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1_000 },
  createdAt: 1_700_000_000_000,
};

const baseSession = {
  id: "ses_00000000-0000-7000-8000-000000000000",
  defaultModel: { provider: "openai", model: "gpt-5.4", baseUrl: "https://provider.invalid/v1" },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  metadata: {},
};

describe("Phase 12A public Protocol contracts", () => {
  it("accepts only a transport-safe provider/model selection", () => {
    expect(ClientModelSelectionSchema.parse({ provider: "openai", model: "gpt-5.4" })).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(
      ClientModelSelectionSchema.safeParse({
        provider: "openai",
        model: "gpt-5.4",
        baseUrl: "https://attacker.invalid/v1",
      }).success,
    ).toBe(false);
    expect(
      CreateSessionRequestSchema.safeParse({
        defaultModel: { provider: "openai", model: "gpt-5.4", baseUrl: "https://attacker.invalid" },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        goal: "Inspect",
        workspace: baseRun.workspace,
        model: { provider: "openai", model: "gpt-5.4", baseUrl: "https://attacker.invalid" },
        runtime: baseRun.runtime,
        permissionProfile: baseRun.permissionProfile,
        approvalPolicy: baseRun.approvalPolicy,
        limits: baseRun.limits,
      }).success,
    ).toBe(false);
  });

  it("keeps internal endpoint-bearing models separate from public projections", () => {
    expect(AgentRunSchema.parse(baseRun).model.baseUrl).toBe("https://provider.invalid/v1");
    expect(AgentSessionSchema.parse(baseSession).defaultModel?.baseUrl).toBe(
      "https://provider.invalid/v1",
    );

    const publicRun = ClientAgentRunSchema.parse({
      ...baseRun,
      model: { provider: "openai", model: "gpt-5.4" },
    });
    const publicSession = ClientAgentSessionSchema.parse({
      ...baseSession,
      defaultModel: { provider: "openai", model: "gpt-5.4" },
    });
    expect(publicRun.model).toEqual({ provider: "openai", model: "gpt-5.4" });
    expect(publicSession.defaultModel).toEqual({ provider: "openai", model: "gpt-5.4" });
    expect(ClientAgentRunSchema.safeParse(baseRun).success).toBe(false);
    expect(ClientAgentSessionSchema.safeParse(baseSession).success).toBe(false);
  });

  it("accepts strict DaemonInfo and rejects unknown fields or secret-shaped fields", () => {
    const info = DaemonInfoSchema.parse({
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
      configuredProviders: ["openai"],
      defaultModel: { provider: "openai", model: "gpt-5.4" },
    });
    expect(info.runtimeKinds).toEqual(["local"]);
    expect(DaemonInfoSchema.safeParse({ ...info, apiKey: "secret" }).success).toBe(false);
    expect(DaemonInfoSchema.safeParse({ ...info, unknown: true }).success).toBe(false);
  });

  it("keeps action responses machine-readable and strict", () => {
    const response = RunActionResponseSchema.parse({
      runId: baseRun.id,
      action: "START",
      disposition: "SCHEDULED",
      run: { ...baseRun, model: { provider: "openai", model: "gpt-5.4" } },
    });
    expect(response.action).toBe("START");
    expect(RunActionResponseSchema.safeParse({ ...response, action: "UNKNOWN" }).success).toBe(
      false,
    );
    expect(RunActionResponseSchema.safeParse({ ...response, disposition: "UNKNOWN" }).success).toBe(
      false,
    );
    expect(RunActionResponseSchema.safeParse({ ...response, coreResult: {} }).success).toBe(false);
  });

  it("uses the existing resolution contract and a list envelope for approvals", () => {
    expect(ApprovalResolutionSchema.parse({ action: "APPROVE", scope: "RUN" })).toEqual({
      action: "APPROVE",
      scope: "RUN",
    });
    const list = ApprovalListResponseSchema.parse({
      items: [
        {
          id: "apr_00000000-0000-7000-8000-000000000000",
          runId: baseRun.id,
          toolInvocationId: "tinv_00000000-0000-7000-8000-000000000000",
          riskLevel: "MEDIUM",
          title: "Update a source file",
          reason: "The model requested a workspace mutation",
          action: { summary: "Update a source file" },
          status: "PENDING",
          scope: "ONCE",
          createdAt: 1_700_000_000_000,
          expiresAt: 1_700_000_001_000,
        },
      ],
    });
    expect(list.items).toHaveLength(1);
    expect(ApprovalListResponseSchema.safeParse({ items: [], extra: true }).success).toBe(false);
  });
});
