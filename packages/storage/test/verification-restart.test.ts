import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createStepId,
  createTimestampMs,
  createVerificationCheckId,
  createVerificationEvidenceId,
  createVerificationPlanId,
  type VerificationPlan,
} from "@caelush/protocol";
import {
  ProjectCheckResolverRegistry,
  VerificationRunner,
  type VerificationCommandExecutionPort,
  type VerificationProjectProfile,
} from "@caelush/verification";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession, makeState, makeStep } from "./support/fixtures.js";

const directories: string[] = [];

function makePlan(runId: ReturnType<typeof makeRun>["id"]): VerificationPlan {
  const planId = createVerificationPlanId();
  const createdAt = createTimestampMs(100);
  return {
    id: planId,
    runId,
    sourceStepId: createStepId(),
    plannerVersion: "phase-11a.v1",
    planHash: "a".repeat(64),
    checks: (["TEST", "BUILD"] as const).map((purpose, ordinal) => ({
      id: createVerificationCheckId(),
      planId,
      ordinal,
      stage: ordinal === 0 ? "BEHAVIORAL" : "BROAD",
      requirement: "IF_AVAILABLE" as const,
      spec: { kind: "PROJECT" as const, purpose, source: "SYSTEM" as const },
      status: "PENDING" as const,
      createdAt,
    })),
    createdAt,
  };
}

function discovery(plan: VerificationPlan, checkId: VerificationPlan["checks"][number]["id"]) {
  return {
    id: createVerificationEvidenceId(),
    planId: plan.id,
    checkId,
    kind: "DISCOVERY" as const,
    summary: "Project verification command discovered",
    details: {
      available: true,
      resolver: "FIXTURE@phase-11b.v1",
      ecosystem: "NODE",
      candidateHash: "b".repeat(64),
    },
    capturedAt: createTimestampMs(110),
  };
}

const profile: VerificationProjectProfile = {
  ecosystems: ["NODE"],
  packageManager: { name: "pnpm" },
  tooling: [],
  isMonorepo: false,
};

const sanitizer = {
  redactText: (value: string) => value,
  boundText: (value: string) => ({ text: value, omittedBytes: 0, truncated: false }),
};

function resolver() {
  return new ProjectCheckResolverRegistry([
    {
      ecosystem: "NODE",
      resolve: (check) => ({
        kind: "READY" as const,
        candidate: {
          checkId: check.id,
          executable: "fixture",
          args: [check.spec.kind === "PROJECT" ? check.spec.purpose.toLowerCase() : "check"],
          workdir: ".",
          provenance: {
            ecosystem: "NODE",
            resolver: "FIXTURE@phase-11b.v1",
            evidencePath: "package.json",
          },
          securityInputs: [],
          candidateHash: "b".repeat(64),
        },
      }),
    },
  ]);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("verification restart recovery", () => {
  it("does not replay completed checks and fails closed on a stale RUNNING check", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-verification-"));
    directories.push(directory);
    const databasePath = path.join(directory, "caelush.sqlite");
    const firstStorage = await openCaelushStorage({ path: databasePath });
    const runId = makeRun(makeSession().id).id;
    const plan = makePlan(runId);
    const session = makeSession();
    const run = makeRun(session.id, { id: runId, status: "VERIFYING" });
    await firstStorage.sessions.insert(session);
    await firstStorage.runs.insert(run);
    await firstStorage.steps.insert(
      makeStep(run.id, { id: plan.sourceStepId, status: "COMPLETED" }),
    );
    await firstStorage.runStates.save(makeState(run));
    await firstStorage.verification.createPlan(plan);

    const first = plan.checks[0]!;
    const started = await firstStorage.verificationExecution.startCheck({
      runId,
      sessionId: session.id,
      check: { ...first, status: "RUNNING", startedAt: createTimestampMs(111) },
      discoveryEvidence: discovery(plan, first.id),
    });
    await firstStorage.verificationExecution.settleCheck({
      runId,
      sessionId: session.id,
      check: { ...started.check, status: "PASSED", finishedAt: createTimestampMs(120) },
      evidence: [
        {
          ...discovery(plan, first.id),
          kind: "COMMAND" as const,
          summary: "fixture test",
          details: {
            candidateHash: "b".repeat(64),
            exitCode: 0,
            totalOutputBytes: 2,
            omittedBytes: 0,
          },
          capturedAt: createTimestampMs(121),
        },
      ],
    });
    await firstStorage.close();

    const restarted = await openCaelushStorage({ path: databasePath });
    const afterCompleted = await restarted.verificationExecution.getPlanExecutionSnapshot(plan.id);
    expect(afterCompleted?.plan.checks.map((check) => check.status)).toEqual(["PASSED", "PENDING"]);

    const second = afterCompleted!.plan.checks[1]!;
    await restarted.verificationExecution.startCheck({
      runId,
      sessionId: session.id,
      check: { ...second, status: "RUNNING", startedAt: createTimestampMs(130) },
      discoveryEvidence: discovery(plan, second.id),
    });
    await restarted.close();

    const staleStorage = await openCaelushStorage({ path: databasePath });
    const stale = await staleStorage.verificationExecution.getPlanExecutionSnapshot(plan.id);
    expect(stale?.plan.checks.map((check) => check.status)).toEqual(["PASSED", "RUNNING"]);
    const calls: string[] = [];
    const execution: VerificationCommandExecutionPort = {
      async executeArgv() {
        calls.push("execute");
        return {
          status: "EXITED",
          output: "ok",
          totalOutputBytes: 2,
          omittedBytes: 0,
          exitCode: 0,
        };
      },
      async interact() {
        calls.push("interact");
        throw new Error("stale check must not be polled");
      },
    };
    const result = await new VerificationRunner().run({
      runId,
      sessionId: session.id,
      plan: stale!.plan,
      profile,
      permissionProfile: "FULL_ACCESS",
      approvalPolicy: "DANGEROUS_ONLY",
      now: () => 1_700_000_000_200,
      resolverRegistry: resolver(),
      security: { assess: () => ({ kind: "ALLOW" as const, safeReason: "fixture" }) },
      execution,
      store: staleStorage.verificationExecution,
      evidenceIdFactory: createVerificationEvidenceId,
      evidenceSanitizer: sanitizer,
    });
    expect(result.outcome).toBe("PROJECT_CHECKS_PASSED");
    expect(calls).toEqual([]);
    await staleStorage.close();
  });
});
