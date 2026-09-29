import {
  ApprovalPolicySchema,
  CreateRunRequestSchema,
  CreateSessionRequestSchema,
  EventStreamQuerySchema,
  PermissionProfileSchema,
  RunLimitsSchema,
  RunListQuerySchema,
  SessionListQuerySchema,
  WorkspaceDirectoryPickerResponseSchema,
  WorkspaceRefSchema,
  ModelRefSchema,
  RuntimeRefSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";
import { createWorkspaceId } from "../src/index.js";

const workspace = { id: createWorkspaceId(), path: "C:/workspace" };
const model = { provider: "test", model: "test-model" };
const runtime = { id: "local", kind: "test" };
const limits = { maxSteps: 10, maxToolCalls: 10, timeoutMs: 1000 };

describe("Protocol API contracts", () => {
  it("accepts only client-owned session fields", () => {
    expect(
      CreateSessionRequestSchema.parse({
        title: "Work",
        defaultWorkspace: workspace,
        defaultModel: model,
        metadata: { source: "test" },
      }),
    ).toEqual({
      title: "Work",
      defaultWorkspace: workspace,
      defaultModel: model,
      metadata: { source: "test" },
    });

    expect(CreateSessionRequestSchema.safeParse({ id: "client-id" }).success).toBe(false);
    expect(CreateSessionRequestSchema.safeParse({ createdAt: 1 }).success).toBe(false);
    expect(CreateSessionRequestSchema.safeParse({ updatedAt: 1 }).success).toBe(false);
    expect(CreateSessionRequestSchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("accepts only client-owned run fields", () => {
    expect(
      CreateRunRequestSchema.parse({
        goal: "Do work",
        workspace,
        model,
        runtime,
        permissionProfile: PermissionProfileSchema.parse("READ_ONLY"),
        approvalPolicy: ApprovalPolicySchema.parse("ALWAYS_ASK"),
        limits: RunLimitsSchema.parse(limits),
      }),
    ).toMatchObject({ goal: "Do work", workspace, model, runtime, limits });

    expect(CreateRunRequestSchema.safeParse({ ...limits, status: "RUNNING" }).success).toBe(false);
    expect(CreateRunRequestSchema.safeParse({ goal: "Do work", id: "run-client" }).success).toBe(
      false,
    );
    expect(
      CreateRunRequestSchema.safeParse({
        goal: "Do work",
        sessionId: "ses-client",
        workspace,
        model,
        runtime,
        permissionProfile: "READ_ONLY",
        approvalPolicy: "ALWAYS_ASK",
        limits,
      }).success,
    ).toBe(false);
  });

  it("defaults list limits and rejects values outside the public range", () => {
    expect(SessionListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(RunListQuerySchema.parse({ limit: "100" })).toEqual({ limit: 100 });
    expect(SessionListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(SessionListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(RunListQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
  });

  it("validates event cursors as optional non-negative integers", () => {
    expect(EventStreamQuerySchema.parse({})).toEqual({});
    expect(EventStreamQuerySchema.parse({ afterSequence: "0" })).toEqual({ afterSequence: 0 });
    expect(EventStreamQuerySchema.parse({ afterSequence: "12" })).toEqual({ afterSequence: 12 });
    for (const afterSequence of ["-1", "1.5", "abc", "NaN"]) {
      expect(EventStreamQuerySchema.safeParse({ afterSequence }).success).toBe(false);
    }
  });

  it("keeps the API schemas independent from transport runtime types", () => {
    expect(WorkspaceRefSchema).toBeDefined();
    expect(ModelRefSchema).toBeDefined();
    expect(RuntimeRefSchema).toBeDefined();
  });

  it("represents selected, cancelled, and unavailable native folder picker outcomes", () => {
    expect(
      WorkspaceDirectoryPickerResponseSchema.parse({
        status: "SELECTED",
        path: "D:\\Develop\\Caelush",
      }),
    ).toEqual({ status: "SELECTED", path: "D:\\Develop\\Caelush" });
    expect(WorkspaceDirectoryPickerResponseSchema.parse({ status: "CANCELLED" })).toEqual({
      status: "CANCELLED",
    });
    expect(WorkspaceDirectoryPickerResponseSchema.parse({ status: "UNAVAILABLE" })).toEqual({
      status: "UNAVAILABLE",
    });
    expect(WorkspaceDirectoryPickerResponseSchema.parse({ status: "TIMEOUT" })).toEqual({
      status: "TIMEOUT",
    });
    expect(WorkspaceDirectoryPickerResponseSchema.safeParse({ status: "SELECTED" }).success).toBe(
      false,
    );
  });
});
