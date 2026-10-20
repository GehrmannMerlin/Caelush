import {
  createTimestampMs,
  type VerificationCheck,
  type VerificationEvidence,
} from "@caelush/protocol";
import { createCommandEvidence, createDiscoveryEvidence } from "./evidence.js";
import type {
  ProjectCheckResolution,
  VerificationRunnerInput,
  VerificationRunnerResult,
  VerificationRuntimeExecResult,
} from "./contracts.js";

const DEFAULT_POLL_YIELD_TIME_MS = 5_000;

/**
 * Default bound on one verification command.
 *
 * Long enough for a real typecheck or test suite on a cold cache, short enough that a hung process
 * cannot park a Run for hours. Callers may override it per run; the value is validated, never
 * silently ignored.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60 * 60_000;

interface CommandDeadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

function createCommandDeadline(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): CommandDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new RangeError("Verification commandTimeoutMs must be a bounded positive integer.");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: caller === undefined ? controller.signal : AbortSignal.any([caller, controller.signal]),
    timedOut: () => timedOut,
    dispose: () => clearTimeout(timer),
  };
}

export class VerificationRunner {
  async run(input: VerificationRunnerInput): Promise<VerificationRunnerResult> {
    const counters = {
      executedCount: 0,
      passedCount: 0,
      failedCount: 0,
      errorCount: 0,
      skippedCount: 0,
    };
    let blockingCheckId: VerificationCheck["id"] | undefined;

    const projectChecks = [...input.plan.checks]
      .filter((check) => check.spec.kind === "PROJECT" && check.status === "PENDING")
      .sort((left, right) => left.ordinal - right.ordinal);

    for (const check of projectChecks) {
      if (input.signal?.aborted) {
        return runnerResult("CANCELLED", counters, blockingCheckId);
      }
      const resolution = input.resolverRegistry.resolve(check, input.profile);
      if (resolution.kind === "UNAVAILABLE") {
        const terminal = unavailableCheck(check, input, resolution);
        const settled = await input.store.settleCheck({
          runId: input.runId,
          sessionId: input.sessionId,
          check: terminal.check,
          evidence: [terminal.evidence],
        });
        notifyCommitted(input, settled.events);
        if (terminal.check.status === "SKIPPED") counters.skippedCount += 1;
        else {
          counters.errorCount += 1;
          if (check.requirement !== "ADVISORY") {
            blockingCheckId = check.id;
            break;
          }
        }
        continue;
      }

      const candidate = resolution.candidate;
      const security = input.security.assess({
        permissionProfile: input.permissionProfile,
        approvalPolicy: input.approvalPolicy,
        executable: candidate.executable,
        args: candidate.args,
        workdir: candidate.workdir,
        inputs: candidate.securityInputs,
      });
      if (security.kind !== "ALLOW") {
        const evidence = createDiscoveryEvidence({
          id: input.evidenceIdFactory(),
          planId: input.plan.id,
          checkId: check.id,
          capturedAt: timestamp(input),
          resolver: candidate.provenance.resolver,
          ecosystem: candidate.provenance.ecosystem,
          packageScope: candidate.workdir,
          ...(candidate.provenance.evidencePath === undefined
            ? {}
            : { evidencePath: candidate.provenance.evidencePath }),
          ...(candidate.provenance.scriptName === undefined
            ? {}
            : { scriptName: candidate.provenance.scriptName }),
          candidateHash: candidate.candidateHash,
          securityReasonCode:
            security.kind === "REVIEW_REQUIRED"
              ? "VERIFICATION_REVIEW_REQUIRED"
              : "VERIFICATION_DENIED",
        });
        const terminal = terminalError(check, input);
        const settled = await input.store.settleCheck({
          runId: input.runId,
          sessionId: input.sessionId,
          check: terminal,
          evidence: [evidence],
        });
        notifyCommitted(input, settled.events);
        counters.errorCount += 1;
        if (check.requirement !== "ADVISORY") {
          blockingCheckId = check.id;
          break;
        }
        continue;
      }

      const discoveryEvidence = createDiscoveryEvidence({
        id: input.evidenceIdFactory(),
        planId: input.plan.id,
        checkId: check.id,
        capturedAt: timestamp(input),
        resolver: candidate.provenance.resolver,
        ecosystem: candidate.provenance.ecosystem,
        packageScope: candidate.workdir,
        ...(candidate.provenance.evidencePath === undefined
          ? {}
          : { evidencePath: candidate.provenance.evidencePath }),
        packageManager: candidate.executable,
        ...(candidate.provenance.scriptName === undefined
          ? {}
          : { scriptName: candidate.provenance.scriptName }),
        candidateHash: candidate.candidateHash,
      });
      const startedAt = timestamp(input);
      const runningCheck = { ...check, status: "RUNNING" as const, startedAt };
      const started = await input.store.startCheck({
        runId: input.runId,
        sessionId: input.sessionId,
        check: runningCheck,
        discoveryEvidence,
      });
      notifyCommitted(input, started.events);
      counters.executedCount += 1;

      let execution: VerificationRuntimeExecResult;
      const deadline = createCommandDeadline(
        input.signal,
        input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      );
      try {
        execution = await input.execution.executeArgv({
          signal: deadline.signal,
          ownerRunId: input.runId,
          executable: candidate.executable,
          args: candidate.args,
          workdir: candidate.workdir,
          yieldTimeMs: input.pollYieldTimeMs ?? DEFAULT_POLL_YIELD_TIME_MS,
        });
        while (execution.status === "RUNNING") {
          if (execution.sessionId === undefined) throw new Error("PROCESS_SESSION_UNAVAILABLE");
          if (deadline.timedOut()) throw new Error("VERIFICATION_COMMAND_TIMED_OUT");
          execution = await input.execution.interact({
            signal: deadline.signal,
            ownerRunId: input.runId,
            sessionId: execution.sessionId,
            chars: "",
            yieldTimeMs: input.pollYieldTimeMs ?? DEFAULT_POLL_YIELD_TIME_MS,
          });
        }
        /*
         * A poll that observed the abort returns a killed process rather than throwing. Treat that
         * as the timeout it is, so the check records `ERROR` instead of a misleading "failed".
         */
        if (deadline.timedOut()) throw new Error("VERIFICATION_COMMAND_TIMED_OUT");
      } catch (error) {
        const aborted = input.signal?.aborted === true;
        const timedOut = !aborted && deadline.timedOut();
        const evidence = createCommandEvidence(
          {
            id: input.evidenceIdFactory(),
            planId: input.plan.id,
            checkId: check.id,
            capturedAt: timestamp(input),
            label: labelFor(check),
            candidateHash: candidate.candidateHash,
            totalOutputBytes: 0,
            omittedBytes: 0,
            errorCode: aborted
              ? "RUN_ABORTED"
              : timedOut
                ? "VERIFICATION_TIMEOUT"
                : safeRuntimeErrorCode(error),
          },
          input.evidenceSanitizer,
        );
        const terminal = {
          ...runningCheck,
          status: aborted ? ("CANCELLED" as const) : ("ERROR" as const),
          finishedAt: timestamp(input),
        };
        const settled = await input.store.settleCheck({
          runId: input.runId,
          sessionId: input.sessionId,
          check: terminal,
          evidence: [evidence],
        });
        notifyCommitted(input, settled.events);
        if (aborted) return { outcome: "CANCELLED", ...counters };
        counters.errorCount += 1;
        if (check.requirement !== "ADVISORY") {
          blockingCheckId = check.id;
          break;
        }
        continue;
      } finally {
        // The command is settled either way; an armed timer outliving it would abort nothing and
        // keep the process alive for up to the timeout.
        deadline.dispose();
      }

      const passed = execution.exitCode === 0 && execution.signal === undefined;
      const evidence = createCommandEvidence(
        {
          id: input.evidenceIdFactory(),
          planId: input.plan.id,
          checkId: check.id,
          capturedAt: timestamp(input),
          label: labelFor(check),
          candidateHash: candidate.candidateHash,
          ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
          ...(execution.signal === undefined ? {} : { signal: execution.signal }),
          stdout: execution.stdout ?? execution.output,
          ...(execution.stderr === undefined ? {} : { stderr: execution.stderr }),
          ...(execution.durationMs === undefined ? {} : { durationMs: execution.durationMs }),
          totalOutputBytes: execution.totalOutputBytes,
          omittedBytes: execution.omittedBytes,
        },
        input.evidenceSanitizer,
      );
      const terminal = {
        ...runningCheck,
        status: passed ? ("PASSED" as const) : ("FAILED" as const),
        finishedAt: timestamp(input),
      };
      const settled = await input.store.settleCheck({
        runId: input.runId,
        sessionId: input.sessionId,
        check: terminal,
        evidence: [evidence],
      });
      notifyCommitted(input, settled.events);
      if (passed) counters.passedCount += 1;
      else {
        counters.failedCount += 1;
        if (check.requirement !== "ADVISORY") {
          blockingCheckId = check.id;
          break;
        }
      }
    }

    return runnerResult(
      blockingCheckId === undefined ? "PROJECT_CHECKS_PASSED" : "BLOCKED",
      counters,
      blockingCheckId,
    );
  }
}

function timestamp(input: VerificationRunnerInput) {
  return createTimestampMs(input.now());
}

function notifyCommitted(
  input: VerificationRunnerInput,
  events: Parameters<NonNullable<VerificationRunnerInput["onCommittedEvents"]>>[0],
): void {
  try {
    const notification = input.onCommittedEvents?.(events);
    if (notification !== undefined) void Promise.resolve(notification).catch(() => undefined);
  } catch {
    // Storage has committed; replay remains authoritative if live observer delivery fails.
  }
}

function labelFor(check: VerificationCheck): string {
  return `project ${check.spec.kind === "PROJECT" ? check.spec.purpose.toLowerCase() : "check"}`;
}

function unavailableCheck(
  check: VerificationCheck,
  input: VerificationRunnerInput,
  resolution: Extract<ProjectCheckResolution, { kind: "UNAVAILABLE" }>,
): { check: VerificationCheck; evidence: VerificationEvidence } {
  const evidence = createDiscoveryEvidence({
    id: input.evidenceIdFactory(),
    planId: input.plan.id,
    checkId: check.id,
    capturedAt: timestamp(input),
    resolver: "PROJECT_CHECK_REGISTRY@phase-11b.v1",
    ecosystem: input.profile.ecosystems[0] ?? "UNKNOWN",
    packageScope: ".",
    available: false,
    reason: resolution.reason,
  });
  if (check.requirement === "IF_AVAILABLE" || check.requirement === "ADVISORY") {
    return {
      check: {
        ...check,
        status: "SKIPPED",
        finishedAt: timestamp(input),
        skipReason: "NOT_AVAILABLE",
      },
      evidence,
    };
  }
  return { check: { ...check, status: "ERROR", finishedAt: timestamp(input) }, evidence };
}

function terminalError(
  check: VerificationCheck,
  input: VerificationRunnerInput,
): VerificationCheck {
  return { ...check, status: "ERROR", finishedAt: timestamp(input) };
}

function safeRuntimeErrorCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === "SPAWN_FAILED") return "EXECUTABLE_UNAVAILABLE";
    if (code === "PROCESS_UNCERTAIN") return "PROCESS_UNCERTAIN";
  }
  return "VERIFICATION_EXECUTION_ERROR";
}

function runnerResult(
  outcome: VerificationRunnerResult["outcome"],
  counters: Omit<VerificationRunnerResult, "outcome" | "blockingCheckId">,
  blockingCheckId: VerificationCheck["id"] | undefined,
): VerificationRunnerResult {
  return {
    outcome,
    ...counters,
    ...(blockingCheckId === undefined ? {} : { blockingCheckId }),
  };
}
