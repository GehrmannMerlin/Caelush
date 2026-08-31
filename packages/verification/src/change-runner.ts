import { createTimestampMs, type VerificationCheck } from "@caelush/protocol";
import type {
  VerificationCheckExecutionResult,
  VerificationStageRunnerInput,
  VerificationStageRunnerResult,
} from "./contracts.js";

/** Runs the non-project and project-independent check lifecycle in plan order. */
export class VerificationStageRunner {
  async run(input: VerificationStageRunnerInput): Promise<VerificationStageRunnerResult> {
    const counters = {
      executedCount: 0,
      passedCount: 0,
      failedCount: 0,
      errorCount: 0,
      skippedCount: 0,
    };
    const failedCheckIds: VerificationCheck["id"][] = [];
    const errorCheckIds: VerificationCheck["id"][] = [];
    let blockingCheckId: VerificationCheck["id"] | undefined;

    const checks = [...input.plan.checks]
      .filter((check) => check.status === "PENDING")
      .sort((left, right) => left.ordinal - right.ordinal);
    for (const check of checks) {
      if (input.signal?.aborted) {
        return result("CANCELLED", counters, failedCheckIds, errorCheckIds, blockingCheckId);
      }
      const executor = input.executors[check.spec.kind];
      if (executor === undefined) {
        if (check.requirement === "IF_AVAILABLE" || check.requirement === "ADVISORY") {
          const terminal = {
            ...check,
            status: "SKIPPED" as const,
            finishedAt: timestamp(input),
            skipReason: "NOT_AVAILABLE" as const,
          };
          const settled = await input.store.settleCheck({
            runId: input.runId,
            sessionId: input.sessionId,
            check: terminal,
            evidence: [input.discoveryEvidence(check, terminal.finishedAt)],
          });
          input.onCommittedEvents?.(settled.events);
          counters.skippedCount += 1;
          continue;
        }
        const terminal = {
          ...check,
          status: "ERROR" as const,
          finishedAt: timestamp(input),
        };
        const settled = await input.store.settleCheck({
          runId: input.runId,
          sessionId: input.sessionId,
          check: terminal,
          evidence: [input.discoveryEvidence(check, terminal.finishedAt)],
        });
        input.onCommittedEvents?.(settled.events);
        counters.errorCount += 1;
        errorCheckIds.push(check.id);
        blockingCheckId = check.id;
        break;
      }

      let preflight: VerificationCheckExecutionResult | undefined;
      try {
        preflight = await executor.preflight?.(check, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        const terminal = {
          ...check,
          status: "ERROR" as const,
          finishedAt: timestamp(input),
        };
        const settled = await input.store.settleCheck({
          runId: input.runId,
          sessionId: input.sessionId,
          check: terminal,
          evidence: [input.discoveryEvidence(check, terminal.finishedAt)],
        });
        input.onCommittedEvents?.(settled.events);
        counters.errorCount += 1;
        errorCheckIds.push(check.id);
        blockingCheckId = check.id;
        break;
      }
      if (preflight !== undefined) {
        if (preflight.status !== "SKIPPED") {
          throw new Error("Verification preflight may only skip a check.");
        }
        const terminal = {
          ...check,
          status: "SKIPPED" as const,
          finishedAt: timestamp(input),
          skipReason: preflight.skipReason ?? ("NOT_AVAILABLE" as const),
        };
        const settled = await input.store.settleCheck({
          runId: input.runId,
          sessionId: input.sessionId,
          check: terminal,
          evidence: preflight.evidence,
        });
        input.onCommittedEvents?.(settled.events);
        counters.skippedCount += 1;
        continue;
      }

      const running = { ...check, status: "RUNNING" as const, startedAt: timestamp(input) };
      const started = await input.store.startCheck({
        runId: input.runId,
        sessionId: input.sessionId,
        check: running,
        discoveryEvidence: input.discoveryEvidence(check, running.startedAt),
      });
      input.onCommittedEvents?.(started.events);
      counters.executedCount += 1;
      let execution: VerificationCheckExecutionResult;
      try {
        execution = await executor.execute(check, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        const terminal = {
          ...running,
          status: "ERROR" as const,
          finishedAt: timestamp(input),
        };
        const settled = await input.store.settleCheck({
          runId: input.runId,
          sessionId: input.sessionId,
          check: terminal,
          evidence: [input.discoveryEvidence(check, terminal.finishedAt)],
        });
        input.onCommittedEvents?.(settled.events);
        counters.errorCount += 1;
        errorCheckIds.push(check.id);
        blockingCheckId = check.id;
        break;
      }
      if (execution.status === "SKIPPED") {
        throw new Error("A started verification check cannot be skipped.");
      }
      const terminal = {
        ...running,
        status: execution.status,
        finishedAt: timestamp(input),
      } as VerificationCheck;
      const settled = await input.store.settleCheck({
        runId: input.runId,
        sessionId: input.sessionId,
        check: terminal,
        evidence: execution.evidence,
      });
      input.onCommittedEvents?.(settled.events);
      if (execution.status === "PASSED") counters.passedCount += 1;
      if (execution.status === "FAILED") {
        counters.failedCount += 1;
        failedCheckIds.push(check.id);
      }
      if (execution.status === "ERROR") {
        counters.errorCount += 1;
        errorCheckIds.push(check.id);
      }
      if (
        (execution.status === "FAILED" || execution.status === "ERROR") &&
        check.requirement !== "ADVISORY"
      ) {
        blockingCheckId = check.id;
        break;
      }
    }
    return result(
      blockingCheckId === undefined ? "PASSED" : "BLOCKED",
      counters,
      failedCheckIds,
      errorCheckIds,
      blockingCheckId,
    );
  }
}

function timestamp(input: VerificationStageRunnerInput) {
  return createTimestampMs(input.now());
}

function result(
  outcome: VerificationStageRunnerResult["outcome"],
  counters: Omit<
    VerificationStageRunnerResult,
    "outcome" | "failedCheckIds" | "errorCheckIds" | "blockingCheckId"
  >,
  failedCheckIds: readonly VerificationCheck["id"][],
  errorCheckIds: readonly VerificationCheck["id"][],
  blockingCheckId: VerificationCheck["id"] | undefined,
): VerificationStageRunnerResult {
  return {
    outcome,
    ...counters,
    failedCheckIds,
    errorCheckIds,
    ...(blockingCheckId === undefined ? {} : { blockingCheckId }),
  };
}
