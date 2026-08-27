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

function buildFixtures() {
  const sessionId = getFactory("createSessionId");
  const runId = getFactory("createRunId");
  const stepId = getFactory("createStepId");
  const planItemId = getFactory("createPlanItemId");
  const workspaceId = getFactory("createWorkspaceId");
  if (
    sessionId === undefined ||
    runId === undefined ||
    stepId === undefined ||
    planItemId === undefined ||
    workspaceId === undefined
  ) {
    return undefined;
  }

  const timestamp = 1_700_000_000_000;
  const workspace = { id: workspaceId(), path: "D:/workspace" };
  const run = {
    id: runId(),
    sessionId: sessionId(),
    goal: "verify the project",
    status: "PENDING",
    workspace,
    model: { provider: "local", model: "test-model" },
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS",
    approvalPolicy: "DANGEROUS_ONLY",
    limits: { maxSteps: 10, maxToolCalls: 20, timeoutMs: 30_000 },
    createdAt: timestamp,
  };
  const step = {
    id: stepId(),
    runId: run.id,
    sequence: 1,
    status: "RUNNING",
    startedAt: timestamp,
  };
  const plan = {
    id: planItemId(),
    title: "Verify the project",
    status: "IN_PROGRESS",
  };
  const session = {
    id: run.sessionId,
    title: "Phase 1",
    defaultWorkspace: workspace,
    defaultModel: { provider: "local", model: "test-model" },
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: { source: "test" },
  };

  return { session, run, step, plan };
}

describe("protocol domain contracts", () => {
  it("parses a Session, Run, Step, and PlanItem with their distinct semantics", () => {
    const sessionSchema = getSchema("AgentSessionSchema");
    const runSchema = getSchema("AgentRunSchema");
    const stepSchema = getSchema("AgentStepSchema");
    const planSchema = getSchema("PlanItemSchema");
    const fixtures = buildFixtures();
    if (
      sessionSchema === undefined ||
      runSchema === undefined ||
      stepSchema === undefined ||
      planSchema === undefined ||
      fixtures === undefined
    ) {
      return;
    }

    expect(sessionSchema.parse(fixtures.session)).toEqual(fixtures.session);
    expect(runSchema.parse(fixtures.run)).toEqual(fixtures.run);
    expect(stepSchema.parse(fixtures.step)).toEqual(fixtures.step);
    expect(planSchema.parse(fixtures.plan)).toEqual(fixtures.plan);
  });

  it("rejects unknown fields, invalid limits, and nonpositive step sequences", () => {
    const sessionSchema = getSchema("AgentSessionSchema");
    const limitsSchema = getSchema("RunLimitsSchema");
    const stepSchema = getSchema("AgentStepSchema");
    const fixtures = buildFixtures();
    if (
      sessionSchema === undefined ||
      limitsSchema === undefined ||
      stepSchema === undefined ||
      fixtures === undefined
    ) {
      return;
    }

    expect(sessionSchema.safeParse({ ...fixtures.session, typo: true }).success).toBe(false);
    expect(limitsSchema.safeParse({ maxSteps: 0, maxToolCalls: 1, timeoutMs: 1 }).success).toBe(
      false,
    );
    expect(stepSchema.safeParse({ ...fixtures.step, sequence: 0 }).success).toBe(false);
  });

  it("round-trips domain records through JSON without runtime objects", () => {
    const schemas = [
      getSchema("AgentSessionSchema"),
      getSchema("AgentRunSchema"),
      getSchema("AgentStepSchema"),
      getSchema("PlanItemSchema"),
    ];
    const fixtures = buildFixtures();
    if (schemas.some((schema) => schema === undefined) || fixtures === undefined) {
      return;
    }

    const values = [fixtures.session, fixtures.run, fixtures.step, fixtures.plan];
    for (const [schema, value] of schemas.map(
      (schema, index) => [schema, values[index]] as const,
    )) {
      schema?.parse(JSON.parse(JSON.stringify(value)));
    }
  });
});
