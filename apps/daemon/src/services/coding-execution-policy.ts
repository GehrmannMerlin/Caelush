import { selectCodingExecutionDiscipline } from "@caelush/coding-agent";
import type { AgentRun, RunCorrectionRecoveryRecordV1 } from "@caelush/protocol";

/** Select the Coding policy for one Run without reinterpreting historical Runs after restart. */
export function resolveRunCodingExecutionDiscipline(
  run: Pick<AgentRun, "id" | "resourcePolicy">,
  recovery: RunCorrectionRecoveryRecordV1 | null,
): string | undefined {
  const correctionVersion =
    run.resourcePolicy?.correctionVersion ??
    (recovery?.runId === run.id && recovery.fromCorrectionVersion === "HISTORICAL_V1"
      ? recovery.effectiveCorrectionVersion
      : undefined);
  return selectCodingExecutionDiscipline(correctionVersion);
}
