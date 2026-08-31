import {
  createRunId,
  createSessionId,
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type VerificationCheck,
  type VerificationEvidence,
  type VerificationPlan,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import {
  DefaultVerificationPlanner,
  ProjectCheckResolverRegistry,
  VerificationRunner,
  createVerificationCandidate,
  type VerificationCommandExecutionPort,
  type VerificationProjectProfile,
  type VerificationRuntimeExecResult,
} from "../src/index.js";

const runId = createRunId();
const sessionId = createSessionId();
const profile: VerificationProjectProfile = {
  ecosystems: ["NODE"],
  packageManager: { name: "pnpm" },
  tooling: [],
  isMonorepo: false,
  rootPackage: {
    relativePath: ".",
    scripts: [
      { name: "lint", command: "eslint ." },
      { name: "test", command: "vitest run" },
      { name: "build", command: "tsc -b" },
    ],
  },
};

function planFor(...purposes: Array<"LINT" | "TYPECHECK" | "TEST" | "BUILD">): VerificationPlan {
  const planId = createVerificationPlanId();
  const now = createTimestampMs(1_700_000_000_000);
  return {
    id: planId,
    runId,
    sourceStepId: createStepId(),
    plannerVersion: "phase-11a.v1",
    planHash: "a".repeat(64),
    checks: purposes.map((purpose, ordinal) => ({
      id: createVerificationCheckId(),
      planId,
      ordinal,
      stage: ordinal === 0 ? "FAST_STATIC" : "BEHAVIORAL",
      requirement: "IF_AVAILABLE",
      spec: { kind: "PROJECT", purpose, source: "SYSTEM" },
      status: "PENDING",
      createdAt: now,
    })),
    createdAt: now,
  };
}

function sanitizer() {
  return {
    redactText: (value: string) => value.replaceAll("SECRET", "[REDACTED]"),
    boundText: (value: string, maxBytes: number) => ({
      text: value.slice(0, maxBytes),
      omittedBytes: Math.max(0, value.length - maxBytes),
      truncated: value.length > maxBytes,
    }),
  };
}

function execution(
  first: VerificationRuntimeExecResult = {
    status: "EXITED",
    output: "ok",
    stdout: "ok",
    totalOutputBytes: 2,
    omittedBytes: 0,
    exitCode: 0,
    durationMs: 10,
  },
) {
  const calls: string[] = [];
  const port: VerificationCommandExecutionPort = {
    async executeArgv(request) {
      calls.push(`execute:${request.executable}:${request.args.join(" ")}`);
      return first;
    },
    async interact(request) {
      calls.push(`poll:${request.chars}`);
      return { ...first, status: "EXITED", sessionId: request.sessionId };
    },
  };
  return { port, calls };
}

function input(
  plan: VerificationPlan,
  executionPort: VerificationCommandExecutionPort,
  store: {
    calls: string[];
    startCheck: (value: any) => Promise<any>;
    settleCheck: (value: any) => Promise<any>;
  },
  overrides: Record<string, unknown> = {},
) {
  return {
    runId,
    sessionId,
    plan,
    profile,
    permissionProfile: "FULL_ACCESS" as const,
    approvalPolicy: "DANGEROUS_ONLY" as const,
    now: () => 1_700_000_000_100,
    resolverRegistry: new ProjectCheckResolverRegistry(),
    security: { assess: () => ({ kind: "ALLOW" as const, safeReason: "allowed" }) },
    execution: executionPort,
    store,
    evidenceIdFactory: createVerificationEvidenceId,
    evidenceSanitizer: sanitizer(),
    ...overrides,
  };
}

function store() {
  const calls: string[] = [];
  const value = {
    calls,
    async startCheck(commit: { check: VerificationCheck }) {
      calls.push(`start:${commit.check.id}`);
      return { check: commit.check };
    },
    async settleCheck(commit: {
      check: VerificationCheck;
      evidence: readonly VerificationEvidence[];
    }) {
      calls.push(`settle:${commit.check.status}`);
      return { check: commit.check };
    },
  };
  return value;
}

describe("storage-free verification runner", () => {
  it("durably starts before execution, polls RUNNING with empty stdin, and settles passed evidence", async () => {
    const plan = planFor("TEST");
    const process = execution({
      status: "RUNNING",
      sessionId: "proc_generation_1",
      output: "partial",
      stdout: "partial",
      totalOutputBytes: 7,
      omittedBytes: 0,
    });
    process.port = process.port;
    const calls: string[] = process.calls;
    const originalExecute = process.port.executeArgv;
    process.port.executeArgv = async (request) => {
      calls.push("runtime");
      return originalExecute(request);
    };
    const executionPort: VerificationCommandExecutionPort = {
      executeArgv: async (request) => {
        calls.push("runtime");
        return {
          status: "RUNNING",
          sessionId: "proc_generation_1",
          output: "partial",
          totalOutputBytes: 7,
          omittedBytes: 0,
        };
      },
      interact: async (request) => {
        calls.push(`poll:${request.chars}`);
        return {
          status: "EXITED",
          sessionId: request.sessionId,
          output: "ok",
          stdout: "ok",
          totalOutputBytes: 2,
          omittedBytes: 0,
          exitCode: 0,
          durationMs: 20,
        };
      },
    };
    const durable = store();
    const result = await new VerificationRunner().run(
      input(plan, executionPort, durable, {
        now: () => 1_700_000_000_100,
      }),
    );
    expect(result.outcome).toBe("PROJECT_CHECKS_PASSED");
    expect(executionPort).toBeDefined();
    expect(durable.calls).toEqual([`start:${plan.checks[0]!.id}`, "settle:PASSED"]);
    expect(calls).toContain("poll:");
  });

  it("maps unavailable checks and security review to terminal ERROR/SKIPPED without execution", async () => {
    const plan = planFor("TYPECHECK");
    const process = execution();
    const durable = store();
    const unavailable = await new VerificationRunner().run(
      input(plan, process.port, durable, {
        resolverRegistry: {
          resolve: () => ({ kind: "UNAVAILABLE", reason: "SCRIPT_NOT_DEFINED" as const }),
        },
      }),
    );
    expect(unavailable.outcome).toBe("PROJECT_CHECKS_PASSED");
    expect(process.calls).toEqual([]);
    expect(durable.calls).toEqual(["settle:SKIPPED"]);

    const reviewedProcess = execution();
    const reviewedStore = store();
    const reviewed = await new VerificationRunner().run(
      input(planFor("TEST"), reviewedProcess.port, reviewedStore, {
        security: {
          assess: () => ({
            kind: "REVIEW_REQUIRED" as const,
            reasonCode: "NETWORK",
            safeReason: "review",
          }),
        },
      }),
    );
    expect(reviewed.outcome).toBe("BLOCKED");
    expect(reviewedProcess.calls).toEqual([]);
    expect(reviewedStore.calls).toEqual(["settle:ERROR"]);
  });

  it("fails fast after a blocking non-zero exit and preserves bounded redacted output through evidence", async () => {
    const plan = planFor("TEST", "BUILD");
    const processCalls: string[] = [];
    const executionPort: VerificationCommandExecutionPort = {
      async executeArgv(request) {
        processCalls.push(request.args.at(-1) ?? "");
        return {
          status: "EXITED",
          output: "SECRET failure",
          stdout: "SECRET failure",
          totalOutputBytes: 14,
          omittedBytes: 0,
          exitCode: 1,
          durationMs: 3,
        };
      },
      async interact() {
        throw new Error("must not poll");
      },
    };
    const durable = store();
    const result = await new VerificationRunner().run(input(plan, executionPort, durable));
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blockingCheckId).toBe(plan.checks[0]!.id);
    expect(processCalls).toEqual(["test"]);
    expect(durable.calls).toEqual([`start:${plan.checks[0]!.id}`, "settle:FAILED"]);
  });
});
