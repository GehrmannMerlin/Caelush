import { describe, expect, it } from "vitest";
import {
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  createApprovalRequestId,
  createRunId,
  createToolInvocationId,
} from "../src/index.js";

function pending() {
  return {
    id: createApprovalRequestId(),
    runId: createRunId(),
    toolInvocationId: createToolInvocationId(),
    riskLevel: "HIGH" as const,
    title: "Approve tool execution",
    reason: "The active policy requires review.",
    action: { kind: "TOOL_EXECUTION", toolName: "apply_patch" },
    status: "PENDING" as const,
    scope: "RUN" as const,
    expiresAt: 1_700_000_000_900,
    createdAt: 1_700_000_000_000,
  };
}

describe("durable approval protocol", () => {
  it("accepts only the strict approval resolution union", () => {
    expect(ApprovalResolutionSchema.parse({ action: "APPROVE", scope: "ONCE" })).toEqual({
      action: "APPROVE",
      scope: "ONCE",
    });
    expect(ApprovalResolutionSchema.parse({ action: "REJECT" })).toEqual({ action: "REJECT" });
    expect(ApprovalResolutionSchema.safeParse({ action: "REJECT", scope: "RUN" }).success).toBe(
      false,
    );
    expect(ApprovalResolutionSchema.safeParse({ action: "APPROVE" }).success).toBe(false);
  });

  it("enforces terminal approval fields and temporal invariants", () => {
    const value = pending();
    expect(ApprovalRequestSchema.parse(value)).toEqual(value);
    expect(
      ApprovalRequestSchema.safeParse({ ...value, status: "APPROVED", resolvedAt: value.createdAt })
        .success,
    ).toBe(false);
    expect(
      ApprovalRequestSchema.safeParse({
        ...value,
        status: "APPROVED",
        grantedScope: "RUN",
        resolvedAt: value.createdAt,
      }).success,
    ).toBe(true);
    expect(ApprovalRequestSchema.safeParse({ ...value, expiresAt: value.createdAt }).success).toBe(
      false,
    );
  });
});
