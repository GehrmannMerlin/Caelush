import { createRunId, createStepId, createWorkspaceId } from "../src/index.js";
import * as protocol from "../src/index.js";
import { describe, expect, it } from "vitest";

const api = protocol as Record<string, unknown>;

function schema(name: string): {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
} {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  return value as {
    parse(value: unknown): unknown;
    safeParse(value: unknown): { success: boolean };
  };
}

describe("Phase 11A Verification contracts", () => {
  it("exports strict UUIDv7 identifiers for plans, checks, and evidence", () => {
    const contracts = [
      ["VerificationPlanIdSchema", "createVerificationPlanId", "vplan_"],
      ["VerificationCheckIdSchema", "createVerificationCheckId", "vchk_"],
      ["VerificationEvidenceIdSchema", "createVerificationEvidenceId", "vevd_"],
    ] as const;

    for (const [schemaName, factoryName, prefix] of contracts) {
      const value = api[factoryName];
      expect(value, `${factoryName} must be exported`).toBeTypeOf("function");
      const identifier = (value as () => string)();
      expect(identifier.startsWith(prefix)).toBe(true);
      expect(schema(schemaName).parse(identifier)).toBe(identifier);
    }
  });

  it("accepts a bounded plan with every supported intent family", () => {
    const planSchema = schema("VerificationPlanSchema");
    const runId = createRunId();
    const sourceStepId = createStepId();
    const planId = (api.createVerificationPlanId as () => string)();
    const checkId = () => (api.createVerificationCheckId as () => string)();
    const plan = {
      id: planId,
      runId,
      sourceStepId,
      plannerVersion: "phase-11a.v1",
      planHash: "a".repeat(64),
      checks: [
        {
          id: checkId(),
          planId,
          ordinal: 0,
          stage: "FAST_STATIC",
          requirement: "IF_AVAILABLE",
          spec: { kind: "PROJECT", purpose: "LINT", source: "SYSTEM" },
          status: "PENDING",
          createdAt: 1_700_000_000_000,
        },
        {
          id: checkId(),
          planId,
          ordinal: 1,
          stage: "CHANGE_REVIEW",
          requirement: "REQUIRED",
          spec: { kind: "WORKSPACE", purpose: "CHANGESET_SANITY", source: "SYSTEM" },
          status: "PENDING",
          createdAt: 1_700_000_000_000,
        },
        {
          id: checkId(),
          planId,
          ordinal: 2,
          stage: "ACCEPTANCE",
          requirement: "REQUIRED",
          spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
          status: "PENDING",
          createdAt: 1_700_000_000_000,
        },
      ],
      createdAt: 1_700_000_000_000,
    };

    expect(planSchema.parse(plan)).toEqual(plan);
  });

  it("rejects unknown fields and invalid plan/check bounds", () => {
    const planSchema = schema("VerificationPlanSchema");
    const planId = (api.createVerificationPlanId as () => string)();
    const plan = {
      id: planId,
      runId: createRunId(),
      sourceStepId: createStepId(),
      plannerVersion: "phase-11a.v1",
      planHash: "b".repeat(64),
      checks: [],
      createdAt: 1_700_000_000_000,
    };

    expect(planSchema.safeParse({ ...plan, extra: true }).success).toBe(false);
    expect(
      planSchema.safeParse({
        ...plan,
        checks: Array.from({ length: 33 }, (_, ordinal) => ({
          id: (api.createVerificationCheckId as () => string)(),
          planId,
          ordinal,
          stage: "ACCEPTANCE",
          requirement: "REQUIRED",
          spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
          status: "PENDING",
          createdAt: 1_700_000_000_000,
        })),
      }).success,
    ).toBe(false);
    expect(
      planSchema.safeParse({
        ...plan,
        checks: [
          {
            id: (api.createVerificationCheckId as () => string)(),
            planId,
            ordinal: 0,
            stage: "NOT_A_STAGE",
            requirement: "REQUIRED",
            spec: { kind: "TASK", purpose: "ACCEPTANCE", source: "SYSTEM" },
            status: "PENDING",
            createdAt: 1_700_000_000_000,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps evidence bounded and JSON-safe", () => {
    const evidenceSchema = schema("VerificationEvidenceSchema");
    const planId = (api.createVerificationPlanId as () => string)();
    const checkId = (api.createVerificationCheckId as () => string)();
    const evidence = {
      id: (api.createVerificationEvidenceId as () => string)(),
      planId,
      checkId,
      kind: "DISCOVERY",
      summary: "The project does not expose a reliable test command.",
      details: { available: false, reason: "NOT_AVAILABLE" },
      capturedAt: 1_700_000_000_000,
    };

    expect(evidenceSchema.parse(evidence)).toEqual(evidence);
    expect(evidenceSchema.safeParse({ ...evidence, summary: "x".repeat(2_049) }).success).toBe(
      false,
    );
    expect(evidenceSchema.safeParse({ ...evidence, details: new Map() }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...evidence, details: 1n }).success).toBe(false);
    expect(evidenceSchema.safeParse({ ...evidence, details: new Error("secret") }).success).toBe(
      false,
    );
  });

  it("validates planning facts without accepting service objects", () => {
    const inputSchema = schema("VerificationPlanningInputSchema");
    const input = {
      runId: createRunId(),
      sourceStepId: createStepId(),
      goal: "Implement verification planning",
      workspace: { id: createWorkspaceId(), path: "C:/workspace" },
      changedFiles: [],
      projectFacts: { isCodeProject: true, isGitRepository: false },
    };

    expect(inputSchema.parse(input)).toEqual(input);
    expect(inputSchema.safeParse({ ...input, storage: {} }).success).toBe(false);
  });
});
