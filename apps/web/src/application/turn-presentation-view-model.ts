import { isTerminalRunStatus } from "@caelush/client";
import type {
  RunStatus,
  SessionTurnPresentationTurnV3,
  TurnPresentationItemV3,
} from "@caelush/protocol";

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "PENDING",
  "RUNNING",
  "WAITING_APPROVAL",
  "WAITING_RESOURCE",
  "VERIFYING",
]);

export interface TurnPresentationViewModel {
  readonly turn: SessionTurnPresentationTurnV3;
  readonly runStatus: RunStatus;
  readonly isActive: boolean;
  readonly isTerminal: boolean;
  readonly userItems: readonly Extract<TurnPresentationItemV3, { kind: "USER" }>[];
  readonly processItems: readonly TurnPresentationItemV3[];
  readonly finalAnswerItems: readonly Extract<TurnPresentationItemV3, { kind: "ASSISTANT" }>[];
  readonly runSummaries: readonly Extract<TurnPresentationItemV3, { kind: "RUN_SUMMARY" }>[];
  readonly toolActivities: readonly Extract<TurnPresentationItemV3, { kind: "TOOL" }>[];
  readonly verificationActivities: readonly Extract<
    TurnPresentationItemV3,
    { kind: "VERIFICATION" }
  >[];
  readonly activityCount: number;
  readonly elapsedMs: number;
}

/**
 * Project the server's ordered Turn into display categories without changing its ordinal order.
 * A Run's local ordinals have no meaning outside that one Turn.
 */
export function projectTurnPresentation(
  turn: SessionTurnPresentationTurnV3,
  activeRun: { readonly id: string; readonly status: RunStatus } | undefined,
  now: number,
): TurnPresentationViewModel {
  const isActive = activeRun?.id === turn.runId && ACTIVE_RUN_STATUSES.has(activeRun.status);
  const runStatus = activeRun?.id === turn.runId ? activeRun.status : turn.runStatus;
  const userItems = turn.items.filter((item) => item.kind === "USER");
  const finalAnswerItems = turn.items.filter(
    (item): item is Extract<TurnPresentationItemV3, { kind: "ASSISTANT" }> =>
      item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER",
  );
  const runSummaries = turn.items.filter((item) => item.kind === "RUN_SUMMARY");
  const processItems = turn.items.filter(
    (item) =>
      item.kind !== "USER" &&
      item.kind !== "RUN_SUMMARY" &&
      !(item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER"),
  );
  const toolActivities = processItems.filter((item) => item.kind === "TOOL");
  const verificationActivities = processItems.filter((item) => item.kind === "VERIFICATION");
  const closedAt =
    turn.closedAt ??
    runSummaries.at(-1)?.createdAt ??
    (!ACTIVE_RUN_STATUSES.has(runStatus)
      ? turn.items.reduce(
          (latest, item) => Math.max(latest, Number(item.createdAt)),
          Number(turn.openedAt),
        )
      : undefined);

  return {
    turn,
    runStatus,
    isActive,
    isTerminal: isTerminalRunStatus(runStatus),
    userItems,
    processItems,
    finalAnswerItems,
    runSummaries,
    toolActivities,
    verificationActivities,
    activityCount: processItems.length,
    elapsedMs: Math.max(0, Number(closedAt ?? now) - Number(turn.openedAt)),
  };
}
