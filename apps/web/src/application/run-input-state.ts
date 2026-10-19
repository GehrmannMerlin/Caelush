import type { RunId, RunInputStage } from "@caelush/protocol";

/**
 * One Run input as the shared workbench shows it.
 *
 * ```text
 * SENDING   a request is in flight; the identity already exists and a retry reuses it
 * PENDING   durably accepted, waiting for a safe boundary
 * RECORDED  canonical conversation message exists, waiting for a model step
 * ASSIGNED  the message was part of a prepared model step
 * REJECTED  the Run refused it; the draft is kept so nothing is lost
 * ```
 *
 * The stages are deliberately *not* collapsed into "sent". A correction that was accepted is not a
 * correction the model has seen, and a UI that says otherwise is lying about work it did not do.
 */
export type WebRunInputStage = "SENDING" | RunInputStage | "REJECTED";

export interface WebRunInputItem {
  readonly inputId: string;
  readonly runId: RunId;
  readonly text: string;
  readonly stage: WebRunInputStage;
  readonly acceptedSequence?: number;
  readonly messageId?: string;
  readonly firstStepId?: string;
  /** The bounded, content-free reason a refusal reported. */
  readonly errorReason?: string;
}

/** Insert or replace one item by its stable identity; never duplicate an optimistic row. */
export function upsertRunInput(
  items: readonly WebRunInputItem[],
  item: WebRunInputItem,
): readonly WebRunInputItem[] {
  const index = items.findIndex((candidate) => candidate.inputId === item.inputId);
  if (index < 0) return [...items, item];
  const next = [...items];
  const current = items[index]!;
  const stage = mergeRunInputStage(current.stage, item.stage);
  const errorReason = stage === "REJECTED" ? (item.errorReason ?? current.errorReason) : undefined;
  next[index] = {
    ...current,
    ...item,
    stage,
    ...(current.acceptedSequence === undefined && item.acceptedSequence === undefined
      ? {}
      : { acceptedSequence: item.acceptedSequence ?? current.acceptedSequence }),
    ...(current.messageId === undefined && item.messageId === undefined
      ? {}
      : { messageId: item.messageId ?? current.messageId }),
    ...(current.firstStepId === undefined && item.firstStepId === undefined
      ? {}
      : { firstStepId: item.firstStepId ?? current.firstStepId }),
    ...(errorReason === undefined ? {} : { errorReason }),
  };
  return next;
}

function mergeRunInputStage(
  current: WebRunInputStage,
  incoming: WebRunInputStage,
): WebRunInputStage {
  if (incoming === "REJECTED") {
    return current === "SENDING" || current === "REJECTED" ? incoming : current;
  }
  if (current === "REJECTED") return incoming;
  return runInputStageOrder[incoming] >= runInputStageOrder[current] ? incoming : current;
}

const runInputStageOrder: Record<Exclude<WebRunInputStage, "REJECTED">, number> = {
  SENDING: 0,
  PENDING: 1,
  RECORDED: 2,
  ASSIGNED: 3,
};

/** Keep only the items belonging to one Run, in acceptance order, bounded. */
export function runInputsForRun(
  items: readonly WebRunInputItem[],
  runId: RunId | undefined,
  limit = 32,
): readonly WebRunInputItem[] {
  if (runId === undefined) return [];
  return items.filter((item) => item.runId === runId).slice(-limit);
}

/**
 * The one sentence a stage may claim.
 *
 * Each sentence states exactly what the durable record proves and nothing more: acceptance is not
 * understanding, and an association is not execution.
 */
export function runInputStageLabel(item: WebRunInputItem): string {
  switch (item.stage) {
    case "SENDING":
      return "正在发送…";
    case "PENDING":
      return "已接收，等待当前响应和工具批次结束。";
    case "RECORDED":
      return "已加入本轮对话，等待模型步骤。";
    case "ASSIGNED":
      return "已纳入模型步骤。";
    case "REJECTED":
      return item.errorReason === "RUN_TERMINAL"
        ? "本轮已结束，此条未纳入模型步骤。"
        : "本轮未受理此条，草稿已保留。";
  }
}

/** Whether the item still needs a place in the composer's pending list. */
export function isRunInputPending(item: WebRunInputItem): boolean {
  return item.stage === "SENDING" || item.stage === "PENDING" || item.stage === "REJECTED";
}
