import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

const api = protocol as Record<string, unknown>;
type SchemaLike = {
  parse: (value: unknown) => string;
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

const idContracts = [
  ["SessionIdSchema", "createSessionId", "ses_"],
  ["RunIdSchema", "createRunId", "run_"],
  ["StepIdSchema", "createStepId", "stp_"],
  ["EventIdSchema", "createEventId", "evt_"],
  ["ToolInvocationIdSchema", "createToolInvocationId", "tinv_"],
  ["ObservationIdSchema", "createObservationId", "obs_"],
  ["ApprovalRequestIdSchema", "createApprovalRequestId", "apr_"],
  ["VerificationResultIdSchema", "createVerificationResultId", "ver_"],
  ["PlanItemIdSchema", "createPlanItemId", "plan_"],
  ["WorkspaceIdSchema", "createWorkspaceId", "wsp_"],
] as const;

describe("protocol domain IDs", () => {
  it("creates a UUIDv7 with the resource prefix for every domain ID", async () => {
    for (const [schemaName, factoryName, prefix] of idContracts) {
      const schema = getSchema(schemaName);
      const factory = getFactory(factoryName);
      if (schema === undefined || factory === undefined) {
        return;
      }

      const value = factory();
      const uuid = value.slice(prefix.length);

      expect(value.startsWith(prefix)).toBe(true);
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(schema.parse(value)).toBe(value);
    }
  });

  it("rejects a valid UUID with the wrong resource prefix", () => {
    const runIdSchema = getSchema("RunIdSchema");
    const sessionIdFactory = getFactory("createSessionId");
    if (runIdSchema === undefined || sessionIdFactory === undefined) {
      return;
    }

    expect(runIdSchema.safeParse(sessionIdFactory()).success).toBe(false);
  });

  it("rejects malformed and non-v7 UUID identifiers", () => {
    const sessionIdSchema = getSchema("SessionIdSchema");
    if (sessionIdSchema === undefined) {
      return;
    }

    expect(sessionIdSchema.safeParse("ses_not-a-uuid").success).toBe(false);
    expect(sessionIdSchema.safeParse("ses_00000000-0000-4000-8000-000000000000").success).toBe(
      false,
    );
  });
});
