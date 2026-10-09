import {
  createTimestampMs,
  createVerificationEvidenceId,
  type VerificationCheck,
  type VerificationEvidence,
} from "@caelush/protocol";
import type {
  VerificationCheckExecutionResult,
  VerificationExecutionRecoveryStorePort,
  VerificationExecutionStorePort,
  VerificationSettlementCommitResult,
  VerificationStageRunnerInput,
  VerificationStageRunnerResult,
} from "./contracts.js";
import { parseVerificationEvidence, VerificationEvidenceEncodingError } from "./evidence.js";

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
    const retryCheckIds = new Set(input.retryCheckIds ?? []);
    const checks = [...input.plan.checks]
      .filter(
        (check) =>
          check.status === "PENDING" || (check.status === "ERROR" && retryCheckIds.has(check.id)),
      )
      .sort((left, right) => left.ordinal - right.ordinal);

    for (const check of checks) {
      if (input.signal?.aborted) {
        return result("CANCELLED", counters, failedCheckIds, errorCheckIds, blockingCheckId);
      }
      const executor = input.executors[check.spec.kind];
      if (executor === undefined) {
        if (check.requirement === "IF_AVAILABLE" || check.requirement === "ADVISORY") {
          let discovery: readonly VerificationEvidence[];
          try {
            discovery = checkedEvidence(
              [input.discoveryEvidence(check, timestamp(input))],
              input.plan.id,
              check.id,
            );
          } catch (error) {
            await settleInfrastructureError(
              input,
              check,
              check,
              evidenceErrorCode(error),
              counters,
              errorCheckIds,
            );
            blockingCheckId = check.id;
            break;
          }
          const skipped = {
            ...check,
            status: "SKIPPED" as const,
            finishedAt: timestamp(input),
            skipReason: "NOT_AVAILABLE" as const,
          };
          const settled = await persistSettlement(input, skipped, discovery);
          notifyCommitted(input, settled.events);
          if (settled.check.status === "SKIPPED") counters.skippedCount += 1;
          else {
            counters.errorCount += 1;
            errorCheckIds.push(check.id);
            blockingCheckId = check.id;
            break;
          }
          continue;
        }
        await settleInfrastructureError(
          input,
          check,
          check,
          "VERIFICATION_EXECUTOR_UNAVAILABLE",
          counters,
          errorCheckIds,
        );
        blockingCheckId = check.id;
        break;
      }

      let preflight: VerificationCheckExecutionResult | undefined;
      try {
        preflight = await executor.preflight?.(check, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        await settleInfrastructureError(
          input,
          check,
          check,
          "VERIFICATION_PREFLIGHT_ERROR",
          counters,
          errorCheckIds,
        );
        blockingCheckId = check.id;
        break;
      }
      if (preflight !== undefined) {
        let preflightEvidence: readonly VerificationEvidence[];
        try {
          if (preflight.status !== "SKIPPED") {
            throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_ENCODING_ERROR");
          }
          preflightEvidence = checkedEvidence(preflight.evidence, input.plan.id, check.id);
        } catch (error) {
          await settleInfrastructureError(
            input,
            check,
            check,
            evidenceErrorCode(error),
            counters,
            errorCheckIds,
          );
          blockingCheckId = check.id;
          break;
        }
        if (check.status === "ERROR") {
          counters.errorCount += 1;
          errorCheckIds.push(check.id);
          blockingCheckId = check.id;
          break;
        }
        const skipped = {
          ...check,
          status: "SKIPPED" as const,
          finishedAt: timestamp(input),
          skipReason: preflight.skipReason ?? ("NOT_AVAILABLE" as const),
        };
        const settled = await persistSettlement(input, skipped, preflightEvidence);
        notifyCommitted(input, settled.events);
        if (settled.check.status === "SKIPPED") counters.skippedCount += 1;
        else {
          counters.errorCount += 1;
          errorCheckIds.push(check.id);
          blockingCheckId = check.id;
          break;
        }
        continue;
      }

      let discovery: readonly VerificationEvidence[];
      try {
        discovery = checkedEvidence(
          [input.discoveryEvidence(check, timestamp(input))],
          input.plan.id,
          check.id,
        );
      } catch (error) {
        await settleInfrastructureError(
          input,
          check,
          check,
          evidenceErrorCode(error),
          counters,
          errorCheckIds,
        );
        blockingCheckId = check.id;
        break;
      }

      const startedAt = timestamp(input);
      const running = retryCheckIds.has(check.id)
        ? retryRunningCheck(check, startedAt)
        : { ...check, status: "RUNNING" as const, startedAt };
      let started;
      try {
        started = await input.store.startCheck({
          runId: input.runId,
          sessionId: input.sessionId,
          check: running,
          discoveryEvidence: discovery[0]!,
          ...(retryCheckIds.has(check.id) ? { retry: true } : {}),
        });
      } catch {
        throw new VerificationSettlementError("VERIFICATION_START_ERROR");
      }
      notifyCommitted(input, started.events);
      counters.executedCount += 1;

      let execution: VerificationCheckExecutionResult;
      try {
        execution = await executor.execute(check, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        const cancelled = input.signal?.aborted === true;
        await settleInfrastructureError(
          input,
          check,
          running,
          cancelled ? "VERIFICATION_CANCELLED" : "VERIFICATION_EXECUTOR_ERROR",
          counters,
          errorCheckIds,
          cancelled ? "CANCELLED" : "ERROR",
        );
        if (cancelled) {
          return result("CANCELLED", counters, failedCheckIds, errorCheckIds, blockingCheckId);
        }
        blockingCheckId = check.id;
        break;
      }

      let resultEvidence: readonly VerificationEvidence[];
      try {
        if (execution.status === "SKIPPED") {
          throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_ENCODING_ERROR");
        }
        resultEvidence = checkedEvidence(execution.evidence, input.plan.id, check.id);
      } catch (error) {
        await settleInfrastructureError(
          input,
          check,
          running,
          evidenceErrorCode(error),
          counters,
          errorCheckIds,
        );
        blockingCheckId = check.id;
        break;
      }
      const terminal = {
        ...running,
        status: execution.status,
        finishedAt: timestamp(input),
      } as VerificationCheck;
      const settled = await persistSettlement(input, terminal, resultEvidence);
      notifyCommitted(input, settled.events);
      if (settled.check.status === "PASSED") counters.passedCount += 1;
      if (settled.check.status === "FAILED") {
        counters.failedCount += 1;
        failedCheckIds.push(check.id);
      }
      if (settled.check.status === "ERROR") {
        counters.errorCount += 1;
        errorCheckIds.push(check.id);
      }
      if (
        (settled.check.status === "FAILED" || settled.check.status === "ERROR") &&
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

class VerificationSettlementError extends Error {
  constructor(readonly reasonCode: string) {
    super("Verification check settlement could not be confirmed.");
    this.name = "VerificationSettlementError";
  }
}

async function settleInfrastructureError(
  input: VerificationStageRunnerInput,
  check: VerificationCheck,
  current: VerificationCheck,
  reasonCode: string,
  counters: { errorCount: number },
  errorCheckIds: VerificationCheck["id"][],
  status: "ERROR" | "CANCELLED" = "ERROR",
): Promise<VerificationSettlementCommitResult> {
  if (current.status === "ERROR") {
    counters.errorCount += 1;
    errorCheckIds.push(check.id);
    return { check: current, events: [] };
  }
  const finishedAt = timestamp(input);
  const terminal = { ...current, status, finishedAt } as VerificationCheck;
  const evidence = minimalErrorEvidence(input, check, reasonCode, finishedAt);
  const settled = await persistSettlement(input, terminal, [evidence]);
  notifyCommitted(input, settled.events);
  if (settled.check.status === "ERROR") {
    counters.errorCount += 1;
    errorCheckIds.push(check.id);
  }
  return settled;
}

async function persistSettlement(
  input: VerificationStageRunnerInput,
  check: VerificationCheck,
  evidence: readonly VerificationEvidence[],
): Promise<VerificationSettlementCommitResult> {
  const validated = checkedEvidence(evidence, input.plan.id, check.id);
  try {
    return await input.store.settleCheck({
      runId: input.runId,
      sessionId: input.sessionId,
      check,
      evidence: validated,
    });
  } catch {
    const recovery = input.store as Partial<VerificationExecutionRecoveryStorePort>;
    if (typeof recovery.getPlanExecutionSnapshot !== "function") {
      throw new VerificationSettlementError("VERIFICATION_SETTLEMENT_ERROR");
    }
    let snapshot;
    try {
      snapshot = await recovery.getPlanExecutionSnapshot(input.plan.id);
    } catch {
      throw new VerificationSettlementError("VERIFICATION_SETTLEMENT_ERROR");
    }
    const current = snapshot?.plan.checks.find((item) => item.id === check.id);
    if (
      current !== undefined &&
      current.status === check.status &&
      JSON.stringify(current) === JSON.stringify(check) &&
      validated.every((item) => snapshot?.evidence.some((stored) => stored.id === item.id))
    ) {
      return { check: current, events: [] };
    }
    if (current === undefined || (current.status !== "PENDING" && current.status !== "RUNNING")) {
      throw new VerificationSettlementError("VERIFICATION_SETTLEMENT_ERROR");
    }

    const finishedAt = timestamp(input);
    const failedCheck = {
      ...current,
      status: "ERROR" as const,
      finishedAt,
    } as VerificationCheck;
    const errorEvidence = minimalErrorEvidence(
      input,
      current,
      "VERIFICATION_SETTLEMENT_ERROR",
      finishedAt,
    );
    try {
      return await input.store.settleCheck({
        runId: input.runId,
        sessionId: input.sessionId,
        check: failedCheck,
        evidence: [errorEvidence],
      });
    } catch {
      let after;
      try {
        after = await recovery.getPlanExecutionSnapshot(input.plan.id);
      } catch {
        throw new VerificationSettlementError("VERIFICATION_SETTLEMENT_ERROR");
      }
      const persisted = after?.plan.checks.find((item) => item.id === check.id);
      if (
        persisted?.status === "ERROR" &&
        persisted.finishedAt === finishedAt &&
        after?.evidence.some((item) => item.id === errorEvidence.id)
      ) {
        return { check: persisted, events: [] };
      }
      throw new VerificationSettlementError("VERIFICATION_SETTLEMENT_ERROR");
    }
  }
}

function checkedEvidence(
  values: readonly VerificationEvidence[],
  planId: VerificationCheck["planId"],
  checkId: VerificationCheck["id"],
): readonly VerificationEvidence[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_ENCODING_ERROR");
  }
  const parsed = values.map((value) => parseVerificationEvidence(value));
  if (
    parsed.some((item) => item.planId !== planId || item.checkId !== checkId) ||
    new Set(parsed.map((item) => item.id)).size !== parsed.length
  ) {
    throw new VerificationEvidenceEncodingError("VERIFICATION_EVIDENCE_ENCODING_ERROR");
  }
  return parsed;
}

function minimalErrorEvidence(
  input: VerificationStageRunnerInput,
  check: VerificationCheck,
  reasonCode: string,
  capturedAt: number,
): VerificationEvidence {
  const kind =
    check.spec.kind === "PROJECT"
      ? "COMMAND"
      : check.spec.kind === "WORKSPACE"
        ? "WORKSPACE"
        : check.spec.kind === "GIT"
          ? "GIT"
          : "TASK";
  return parseVerificationEvidence({
    id: (input.evidenceIdFactory ?? createVerificationEvidenceId)(),
    planId: check.planId,
    checkId: check.id,
    kind,
    summary: "Verification infrastructure error",
    details: { errorCode: reasonCode, classification: "INFRASTRUCTURE" },
    capturedAt,
  });
}

function evidenceErrorCode(error: unknown): string {
  if (error instanceof VerificationEvidenceEncodingError) return error.reasonCode;
  return "VERIFICATION_EVIDENCE_ENCODING_ERROR";
}

function notifyCommitted(
  input: VerificationStageRunnerInput,
  events: VerificationSettlementCommitResult["events"],
): void {
  try {
    const notification = input.onCommittedEvents?.(events);
    if (notification !== undefined) void Promise.resolve(notification).catch(() => undefined);
  } catch {
    // The transaction already committed. Replay remains authoritative, and observer delivery must
    // not cause the check to execute or settle a second time.
  }
}

function retryRunningCheck(
  check: VerificationCheck,
  startedAt: NonNullable<VerificationCheck["startedAt"]>,
): VerificationCheck {
  const {
    startedAt: _previousStartedAt,
    finishedAt: _finishedAt,
    skipReason: _skipReason,
    ...base
  } = check;
  void _previousStartedAt;
  void _finishedAt;
  void _skipReason;
  return { ...base, status: "RUNNING", startedAt };
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
