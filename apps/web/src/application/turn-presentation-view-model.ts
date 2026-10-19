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
  const runStatus =
    isTerminalRunStatus(turn.runStatus) || activeRun?.id !== turn.runId
      ? turn.runStatus
      : activeRun.status;
  const isTerminal = isTerminalRunStatus(runStatus);
  const everyUserItem = turn.items.filter((item) => item.kind === "USER");
  /**
   * Only the Run's opening statement belongs above the process disclosure.
   *
   * A correction sent while the Run was working happened *after* the tool work it corrects. The
   * server already places it in the process region at its own timestamp, so this projection keeps
   * that order rather than re-sorting it: presentation order is the server's statement.
   */
  const goalUserItems = everyUserItem.slice(0, 1);
  const userItems = goalUserItems;
  const goalUser = goalUserItems[0];
  const finalAnswerItems = turn.items.filter(
    (item): item is Extract<TurnPresentationItemV3, { kind: "ASSISTANT" }> =>
      item.kind === "ASSISTANT" && item.phase === "FINAL_ANSWER",
  );
  const runSummaries = turn.items.filter((item) => item.kind === "RUN_SUMMARY");
  const processItems = turn.items.filter(
    (item) =>
      item !== goalUser &&
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
    isActive: isActive && !isTerminalRunStatus(turn.runStatus),
    isTerminal,
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
