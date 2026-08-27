import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const api = protocol as Record<string, unknown>;
type SchemaLike = {
  parse: (value: unknown) => unknown;
  safeParse: (value: unknown) => { success: boolean };
};

function getSchema(name: string): SchemaLike | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as SchemaLike;
}

function getFactory(name: string): (() => string) | undefined {
  const value = api[name];
  expect(value, `${name} must be exported`).toBeDefined();
  if (typeof value !== "function") {
    return undefined;
  }

  return value as () => string;
}

describe("protocol observations, approvals, and verification", () => {
  it("parses distinct Tool, Verification, and System observations", () => {
    const observationSchema = getSchema("ObservationSchema");
    const createObservationId = getFactory("createObservationId");
    const createRunId = getFactory("createRunId");
    const createStepId = getFactory("createStepId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    const createVerificationResultId = getFactory("createVerificationResultId");
    if (
      observationSchema === undefined ||
      createObservationId === undefined ||
      createRunId === undefined ||
      createStepId === undefined ||
      createToolInvocationId === undefined ||
      createVerificationResultId === undefined
    ) {
      return;
    }

    const runId = createRunId();
    const stepId = createStepId();
    const base = {
      runId,
      stepId,
      content: "command finished",
      details: { exitCode: 0 },
      isError: false,
      createdAt: 1_700_000_000_000,
    };
    const toolObservation = {
      ...base,
      id: createObservationId(),
      kind: "TOOL",
      toolInvocationId: createToolInvocationId(),
    };
    const verificationObservation = {
      ...base,
      id: createObservationId(),
      kind: "VERIFICATION",
      verificationResultId: createVerificationResultId(),
    };
    const systemObservation = {
      ...base,
      id: createObservationId(),
      kind: "SYSTEM",
    };

    expect(observationSchema.parse(toolObservation)).toEqual(toolObservation);
    expect(observationSchema.parse(verificationObservation)).toEqual(verificationObservation);
    expect(observationSchema.parse(systemObservation)).toEqual(systemObservation);
  });

  it("keeps ApprovalRequest and VerificationResult JSON-safe and strict", () => {
    const approvalSchema = getSchema("ApprovalRequestSchema");
    const verificationSchema = getSchema("VerificationResultSchema");
    const createApprovalRequestId = getFactory("createApprovalRequestId");
    const createVerificationResultId = getFactory("createVerificationResultId");
    const createRunId = getFactory("createRunId");
    const createToolInvocationId = getFactory("createToolInvocationId");
    if (
      approvalSchema === undefined ||
      verificationSchema === undefined ||
      createApprovalRequestId === undefined ||
      createVerificationResultId === undefined ||
      createRunId === undefined ||
      createToolInvocationId === undefined
    ) {
      return;
    }

    const approval = {
      id: createApprovalRequestId(),
      runId: createRunId(),
      toolInvocationId: createToolInvocationId(),
      riskLevel: "HIGH",
      title: "Run command",
      reason: "This command changes project state",
      action: { command: "pnpm test" },
      status: "PENDING",
      scope: "ONCE",
      createdAt: 1_700_000_000_000,
    };
    const verification = {
      id: createVerificationResultId(),
      runId: approval.runId,
      type: "typecheck",
      command: "pnpm typecheck",
      status: "PASSED",
      evidence: { exitCode: 0 },
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_100,
    };

    expect(approvalSchema.parse(approval)).toEqual(approval);
    expect(verificationSchema.parse(verification)).toEqual(verification);
    expect(approvalSchema.safeParse({ ...approval, typo: true }).success).toBe(false);
    expect(verificationSchema.safeParse({ ...verification, finishedAt: -1 }).success).toBe(false);
  });
});
