import type {
  ClientAgentRun,
  SessionTurnPresentationResponse,
  SessionTurnPresentationResponseV3,
  SessionTurnPresentationTurnV3,
  TurnPresentationItemV3,
} from "@caelush/protocol";

type RunPresentationOrder = Pick<ClientAgentRun, "id" | "createdAt">;
type ActivePresentationRun = Pick<ClientAgentRun, "id" | "createdAt" | "goal">;

/** Replace or insert one targeted V3 Turn while retaining the complete Session projection. */
export function mergeActiveTurnPresentation(
  current: SessionTurnPresentationResponseV3,
  targeted: SessionTurnPresentationResponse,
  runs: readonly RunPresentationOrder[],
  activeRun: ActivePresentationRun,
): SessionTurnPresentationResponseV3 | undefined {
  if (targeted.capabilityVersion !== 3) return undefined;

  const refreshedTurn = targeted.turns.find((turn) => turn.runId === activeRun.id);
  if (refreshedTurn === undefined) return current;

  const previousTurn = current.turns.find((turn) => turn.runId === activeRun.id);
  const mergedTurn = withOptimisticUserIfNeeded(refreshedTurn, previousTurn, activeRun);
  const turns = current.turns.filter((turn) => turn.runId !== activeRun.id);
  turns.push(mergedTurn);
  const runCreatedAt = runsByCreatedAt(runs);
  turns.sort((left, right) => compareTurnOrder(left, right, runCreatedAt));

  return { capabilityVersion: 3, turns };
}

function withOptimisticUserIfNeeded(
  refreshedTurn: SessionTurnPresentationTurnV3,
  previousTurn: SessionTurnPresentationTurnV3 | undefined,
  activeRun: ActivePresentationRun,
): SessionTurnPresentationTurnV3 {
  if (refreshedTurn.items.some((item) => item.kind === "USER")) return refreshedTurn;

  const optimisticUser = previousTurn?.items.find(
    (item) => item.kind === "USER" && item.id === `optimistic:presentation:user:${activeRun.id}`,
  );
  const user: TurnPresentationItemV3 = {
    ...(optimisticUser ?? {
      id: `optimistic:presentation:user:${activeRun.id}`,
      runId: activeRun.id,
      status: "COMPLETED" as const,
      createdAt: activeRun.createdAt,
      kind: "USER" as const,
      text: activeRun.goal,
    }),
    conversationTurnId: refreshedTurn.conversationTurnId,
    ordinal: 0,
  };
  const items = [user, ...refreshedTurn.items].map((item, ordinal) => ({ ...item, ordinal }));
  return { ...refreshedTurn, items };
}

function compareTurnOrder(
  left: SessionTurnPresentationTurnV3,
  right: SessionTurnPresentationTurnV3,
  runCreatedAt: ReadonlyMap<string, number>,
): number {
  const leftOpenedAt = runCreatedAt.get(left.runId) ?? Number(left.openedAt);
  const rightOpenedAt = runCreatedAt.get(right.runId) ?? Number(right.openedAt);
  return leftOpenedAt - rightOpenedAt || left.runId.localeCompare(right.runId);
}

function runsByCreatedAt(runs: readonly RunPresentationOrder[]): ReadonlyMap<string, number> {
  return new Map(runs.map((run) => [run.id, Number(run.createdAt)]));
}
