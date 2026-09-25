import type { ConversationTurnId } from "../../messages/types/ids.js";
import type {
  ContextHistoryIndex,
  ContextHistoryUnit,
  ContextHistoryUnitKind,
} from "../history/semantic-history-unit.js";
import {
  assertContextItem,
  createContextItem,
  type ContextFreshness,
  type ContextItem,
  type ContextRetention,
} from "../item/context-item.js";
import {
  classifyContextPressure,
  type ContextBudgetSnapshot,
  type ContextItemDecision,
  type ContextItemDecisionReason,
  type ContextItemDisposition,
  type ContextPlan,
  type ContextPolicy,
} from "../policy/context-policy.js";
import {
  ContextCurrentTurnTooLargeError,
  ContextMandatoryInputTooLargeError,
  ContextPlanningError,
} from "./context-planning-errors.js";

export interface ContextPlannerInput {
  readonly items: readonly ContextItem[];
  readonly policy: ContextPolicy;
  readonly history?: ContextHistoryIndex;
  readonly currentTurnId?: ConversationTurnId;
  readonly sourcePriorities?: Readonly<Record<string, number>>;
}

export interface ContextPlanner {
  plan(input: ContextPlannerInput): ContextPlan;
}

interface PreparedItem {
  readonly item: ContextItem;
  readonly history?: HistoryMembership;
}

interface HistoryMembership {
  readonly groupId: string;
  readonly kind: ContextHistoryUnitKind;
  readonly openProtocol: boolean;
  readonly currentTurn: boolean;
  readonly sequence: number;
}

interface PlanningGroup {
  readonly key: string;
  readonly items: readonly PreparedItem[];
  readonly tokenEstimate: number;
  readonly sourceTokens: ReadonlyMap<string, number>;
  readonly priorityRank: number;
  readonly retentionRank: number;
  readonly freshnessRank: number;
  readonly sourcePriority: number;
  readonly sourceRef: string;
  readonly firstItemId: string;
  readonly mandatory: boolean;
  readonly pinned: boolean;
  readonly currentTurn: boolean;
  readonly openProtocol: boolean;
  readonly historySequence: number;
}

interface GroupDecision {
  readonly group: PlanningGroup;
  readonly disposition: ContextItemDisposition;
  readonly reason: ContextItemDecisionReason;
}

const PRIORITY_RANK: Readonly<Record<ContextItem["priorityClass"], number>> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

const RETENTION_RANK: Readonly<Record<ContextRetention, number>> = {
  PINNED: 0,
  REHYDRATABLE: 1,
  RECENT: 2,
  COMPRESSIBLE: 3,
  EPHEMERAL: 4,
  RETRIEVABLE: 5,
};

const FRESHNESS_RANK: Readonly<Record<ContextFreshness, number>> = {
  CURRENT: 0,
  STALE: 1,
  UNKNOWN: 2,
};

/** Build the canonical in-memory Context Planner. */
export function createContextPlanner(): ContextPlanner {
  return Object.freeze({ plan: planContext });
}

/** Functional form of the canonical Context Planner. */
export function planContext(input: ContextPlannerInput): ContextPlan {
  const items = normalizeItems(input.items);
  const history = indexHistory(input.history, input.currentTurnId);
  const prepared = items.map((item): PreparedItem => {
    const messageId = messageIdOf(item);
    if (messageId === undefined) return { item };
    const historyMembership = history.membershipByMessageId.get(messageId);
    return historyMembership === undefined ? { item } : { item, history: historyMembership };
  });
  validateHistoryReferences(items, input.history, history);
  const groups = buildGroups(prepared, input.sourcePriorities ?? {});
  const orderedGroups = [...groups].sort(compareGroups);
  const mandatoryGroups = orderedGroups.filter((group) => group.mandatory);
  const elasticGroups = orderedGroups.filter((group) => !group.mandatory);

  let selectedTokens = 0;
  let mandatoryTokens = 0;
  const usedBySource = new Map<string, number>();
  const groupDecisions: GroupDecision[] = [];

  for (const group of mandatoryGroups) {
    selectedTokens += group.tokenEstimate;
    mandatoryTokens += group.tokenEstimate;
    addSourceTokens(usedBySource, group.sourceTokens);
    groupDecisions.push({
      group,
      disposition: "SELECTED",
      reason: mandatoryReason(group),
    });
  }

  enforceMandatoryOverflow(
    mandatoryGroups,
    mandatoryTokens,
    input.policy.effectiveInputLimitTokens,
  );

  const mandatoryOverflow = mandatoryTokens > input.policy.effectiveInputLimitTokens;
  if (!mandatoryOverflow) {
    for (const group of elasticGroups) {
      const sourceLimit = sourceLimitFailure(group, usedBySource, input.policy.sourceLimits);
      if (sourceLimit !== undefined) {
        groupDecisions.push({
          group,
          disposition: dispositionForDeferred(group),
          reason: sourceLimit,
        });
        continue;
      }
      if (selectedTokens + group.tokenEstimate > input.policy.effectiveInputLimitTokens) {
        groupDecisions.push({
          group,
          disposition: dispositionForDeferred(group),
          reason: reasonForBudgetOverflow(group),
        });
        continue;
      }
      selectedTokens += group.tokenEstimate;
      addSourceTokens(usedBySource, group.sourceTokens);
      groupDecisions.push({
        group,
        disposition: "SELECTED",
        reason: selectionReason(group),
      });
    }
  } else {
    for (const group of elasticGroups) {
      groupDecisions.push({
        group,
        disposition: dispositionForDeferred(group),
        reason: reasonForBudgetOverflow(group),
      });
    }
  }

  const selectedItems = groupDecisions
    .filter((decision) => decision.disposition === "SELECTED")
    .flatMap((decision) => [...decision.group.items])
    .sort(comparePreparedItems)
    .map((preparedItem) => preparedItem.item);
  const decisions = groupDecisions
    .flatMap((decision) =>
      decision.group.items.map((preparedItem) => ({
        itemId: preparedItem.item.id,
        disposition: decision.disposition,
        reason: decision.reason,
        tokenEstimate: preparedItem.item.tokenEstimate,
      })),
    )
    .sort((left, right) => compareStrings(left.itemId, right.itemId));
  const budget = createBudgetSnapshot(input.policy, mandatoryTokens, selectedTokens);

  return Object.freeze({
    selectedItems: Object.freeze(selectedItems),
    decisions: Object.freeze(decisions.map((decision) => Object.freeze(decision))),
    budget,
    pressure: classifyContextPressure(selectedTokens, input.policy),
    requiresCompaction: selectedTokens > input.policy.effectiveInputLimitTokens,
  });
}

/** Validate the public plan invariants before a downstream document builder consumes a plan. */
export function assertContextPlan(value: unknown): asserts value is ContextPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  const candidate = value as Partial<ContextPlan>;
  if (!Array.isArray(candidate.selectedItems) || !Array.isArray(candidate.decisions)) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  if (candidate.budget === undefined || candidate.budget === null) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  const decisionById = new Map<string, ContextItemDecision>();
  for (const decision of candidate.decisions) {
    if (decisionById.has(decision.itemId)) throw new ContextPlanningError("INCONSISTENT_PLAN");
    decisionById.set(decision.itemId, decision);
  }
  const selectedIds = new Set<string>();
  let selectedTokens = 0;
  for (const item of candidate.selectedItems) {
    if (selectedIds.has(item.id)) throw new ContextPlanningError("INCONSISTENT_PLAN");
    selectedIds.add(item.id);
    const decision = decisionById.get(item.id);
    if (decision?.disposition !== "SELECTED") throw new ContextPlanningError("INCONSISTENT_PLAN");
    selectedTokens += item.tokenEstimate;
  }
  for (const decision of candidate.decisions) {
    if (decision.disposition === "SELECTED" && !selectedIds.has(decision.itemId)) {
      throw new ContextPlanningError("INCONSISTENT_PLAN");
    }
  }
  if (candidate.budget.selectedTokens !== selectedTokens) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
  if (
    candidate.budget.remainingTokens !==
    Math.max(0, candidate.budget.effectiveInputLimitTokens - selectedTokens)
  ) {
    throw new ContextPlanningError("INCONSISTENT_PLAN");
  }
}

function normalizeItems(items: readonly ContextItem[]): readonly ContextItem[] {
  const ids = new Set<string>();
  return items.map((item) => {
    try {
      assertContextItem(item);
    } catch {
      throw new ContextPlanningError("INVALID_CONTEXT_ITEM");
    }
    if (ids.has(item.id)) throw new ContextPlanningError("DUPLICATE_ITEM_ID", { itemId: item.id });
    ids.add(item.id);
    return createContextItem(item);
  });
}

function indexHistory(
  history: ContextHistoryIndex | undefined,
  currentTurnId: ConversationTurnId | undefined,
): {
  readonly membershipByMessageId: ReadonlyMap<string, HistoryMembership>;
} {
  if (history === undefined) return { membershipByMessageId: new Map() };
  const units = [...history.units];
  const latestConversation = [...units]
    .filter((unit) => unit.kind === "CONVERSATION_TURN")
    .sort(compareHistoryUnits)
    .at(-1);
  const activeTurnId = currentTurnId ?? latestConversation?.id.replace(/^conversation:/, "");
  const membershipByMessageId = new Map<string, HistoryMembership>();

  for (const unit of units) {
    if (unit.messages.length === 0 || unit.atomicGroupId.length === 0) {
      throw new ContextPlanningError("BROKEN_ATOMIC_GROUP");
    }
    if (unit.status === "OPEN" && unit.compactionEligible) {
      throw new ContextPlanningError("BROKEN_ATOMIC_GROUP");
    }
    for (const ref of unit.messages) {
      const prior = membershipByMessageId.get(ref.messageId);
      if (prior?.kind === "TOOL_PROTOCOL") continue;
      membershipByMessageId.set(ref.messageId, {
        groupId: unit.atomicGroupId,
        kind: unit.kind,
        openProtocol: unit.kind === "TOOL_PROTOCOL" && unit.status === "OPEN",
        currentTurn: ref.conversationTurnId === activeTurnId,
        sequence: ref.sequence,
      });
    }
  }
  return { membershipByMessageId };
}

function validateHistoryReferences(
  items: readonly ContextItem[],
  history: ContextHistoryIndex | undefined,
  indexed: ReturnType<typeof indexHistory>,
): void {
  if (history === undefined) return;
  for (const item of items) {
    const messageId = messageIdOf(item);
    if (messageId !== undefined && !indexed.membershipByMessageId.has(messageId)) {
      throw new ContextPlanningError("UNKNOWN_ITEM_REFERENCE", { itemId: item.id });
    }
  }
}

function buildGroups(
  prepared: readonly PreparedItem[],
  sourcePriorities: Readonly<Record<string, number>>,
): readonly PlanningGroup[] {
  const byKey = new Map<string, PreparedItem[]>();
  const historyExplicitGroups = new Map<string, string>();

  for (const preparedItem of prepared) {
    const history = preparedItem.history;
    if (history !== undefined && preparedItem.item.atomicGroupId !== undefined) {
      const prior = historyExplicitGroups.get(history.groupId);
      if (prior !== undefined && prior !== preparedItem.item.atomicGroupId) {
        throw new ContextPlanningError("BROKEN_ATOMIC_GROUP", { itemId: preparedItem.item.id });
      }
      historyExplicitGroups.set(history.groupId, preparedItem.item.atomicGroupId);
    }
  }

  for (const preparedItem of prepared) {
    const history = preparedItem.history;
    const explicitGroupId =
      preparedItem.item.atomicGroupId ??
      (history === undefined ? undefined : historyExplicitGroups.get(history.groupId));
    const key =
      explicitGroupId !== undefined
        ? `atomic:${explicitGroupId}`
        : history !== undefined
          ? `history:${history.groupId}`
          : `item:${preparedItem.item.id}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, [preparedItem]);
    else existing.push(preparedItem);
  }

  return [...byKey.entries()].map(([key, entries]) => {
    const sourceTokens = new Map<string, number>();
    for (const entry of entries) {
      sourceTokens.set(
        entry.item.source.providerId,
        (sourceTokens.get(entry.item.source.providerId) ?? 0) + entry.item.tokenEstimate,
      );
    }
    const first = [...entries].sort(comparePreparedItems)[0];
    if (first === undefined) throw new ContextPlanningError("BROKEN_ATOMIC_GROUP");
    return {
      key,
      items: Object.freeze([...entries]),
      tokenEstimate: entries.reduce((total, entry) => total + entry.item.tokenEstimate, 0),
      sourceTokens,
      priorityRank: Math.min(...entries.map((entry) => PRIORITY_RANK[entry.item.priorityClass])),
      retentionRank: Math.min(...entries.map((entry) => RETENTION_RANK[entry.item.retention])),
      freshnessRank: Math.min(...entries.map((entry) => FRESHNESS_RANK[entry.item.freshness])),
      sourcePriority: Math.min(
        ...entries.map(
          (entry) => sourcePriorities[entry.item.source.providerId] ?? Number.MAX_SAFE_INTEGER,
        ),
      ),
      sourceRef: first.item.source.sourceRef,
      firstItemId: first.item.id,
      mandatory: entries.some((entry) => isMandatory(entry)),
      pinned: entries.some((entry) => entry.item.retention === "PINNED"),
      currentTurn: entries.some((entry) => entry.history?.currentTurn === true),
      openProtocol: entries.some((entry) => entry.history?.openProtocol === true),
      historySequence: Math.min(
        ...entries.map((entry) => entry.history?.sequence ?? Number.MAX_SAFE_INTEGER),
      ),
    } satisfies PlanningGroup;
  });
}

function isMandatory(entry: PreparedItem): boolean {
  return (
    entry.item.priorityClass === "CRITICAL" ||
    entry.item.retention === "PINNED" ||
    entry.item.retention === "REHYDRATABLE" ||
    entry.history?.openProtocol === true ||
    entry.history?.currentTurn === true
  );
}

function enforceMandatoryOverflow(
  groups: readonly PlanningGroup[],
  mandatoryTokens: number,
  limit: number,
): void {
  if (mandatoryTokens <= limit) return;
  const current = groups.find((group) => group.currentTurn && group.tokenEstimate > limit);
  if (current !== undefined) {
    const sourceId = current.items[0]?.item.source.providerId;
    throw new ContextCurrentTurnTooLargeError({
      itemId: current.firstItemId,
      ...(sourceId === undefined ? {} : { sourceId }),
    });
  }
  const pinned = groups.find((group) => group.pinned);
  if (pinned !== undefined) {
    const sourceId = pinned.items[0]?.item.source.providerId;
    throw new ContextMandatoryInputTooLargeError({
      itemId: pinned.firstItemId,
      ...(sourceId === undefined ? {} : { sourceId }),
    });
  }
}

function sourceLimitFailure(
  group: PlanningGroup,
  usedBySource: ReadonlyMap<string, number>,
  sourceLimits: Readonly<Record<string, number>>,
): ContextItemDecisionReason | undefined {
  for (const [sourceId, tokens] of group.sourceTokens) {
    const limit = sourceLimits[sourceId];
    if (limit !== undefined && (usedBySource.get(sourceId) ?? 0) + tokens > limit) {
      return "SOURCE_LIMIT";
    }
  }
  return undefined;
}

function addSourceTokens(
  target: Map<string, number>,
  sourceTokens: ReadonlyMap<string, number>,
): void {
  for (const [sourceId, tokens] of sourceTokens) {
    target.set(sourceId, (target.get(sourceId) ?? 0) + tokens);
  }
}

function mandatoryReason(group: PlanningGroup): ContextItemDecisionReason {
  if (group.openProtocol) return "OPEN_PROTOCOL_UNIT";
  if (group.pinned) return "PINNED";
  if (group.currentTurn) return "RECENT";
  return "MANDATORY";
}

function selectionReason(group: PlanningGroup): ContextItemDecisionReason {
  if (group.currentTurn) return "RECENT";
  if (group.items.some((entry) => entry.item.retention === "RECENT")) return "RECENT";
  return "PRIORITY";
}

function dispositionForDeferred(group: PlanningGroup): ContextItemDisposition {
  return group.items.every((entry) => entry.item.retention === "RETRIEVABLE")
    ? "DEFERRED"
    : "DROPPED";
}

function reasonForBudgetOverflow(group: PlanningGroup): ContextItemDecisionReason {
  if (group.items.every((entry) => entry.item.retention === "RETRIEVABLE")) {
    return "RETRIEVABLE_DEFERRED";
  }
  if (group.items.some((entry) => entry.item.freshness === "STALE")) return "STALE";
  return "TOTAL_BUDGET";
}

function createBudgetSnapshot(
  policy: ContextPolicy,
  mandatoryTokens: number,
  selectedTokens: number,
): ContextBudgetSnapshot {
  return Object.freeze({
    contextWindowTokens: policy.contextWindowTokens,
    outputReserveTokens: policy.outputReserveTokens,
    safetyReserveTokens: policy.safetyReserveTokens,
    requestOverheadTokens: policy.requestOverhead.totalTokens,
    effectiveInputLimitTokens: policy.effectiveInputLimitTokens,
    mandatoryTokens,
    selectedTokens,
    remainingTokens: Math.max(0, policy.effectiveInputLimitTokens - selectedTokens),
  });
}

function compareGroups(left: PlanningGroup, right: PlanningGroup): number {
  return (
    left.priorityRank - right.priorityRank ||
    left.retentionRank - right.retentionRank ||
    left.freshnessRank - right.freshnessRank ||
    left.sourcePriority - right.sourcePriority ||
    compareStrings(left.sourceRef, right.sourceRef) ||
    compareStrings(left.firstItemId, right.firstItemId)
  );
}

function comparePreparedItems(left: PreparedItem, right: PreparedItem): number {
  return (
    (left.history?.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.history?.sequence ?? Number.MAX_SAFE_INTEGER) ||
    compareStrings(left.item.source.sourceRef, right.item.source.sourceRef) ||
    compareStrings(left.item.id, right.item.id)
  );
}

function compareHistoryUnits(left: ContextHistoryUnit, right: ContextHistoryUnit): number {
  const leftSequence = left.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.messages[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
  return leftSequence - rightSequence || compareStrings(left.id, right.id);
}

function messageIdOf(item: ContextItem): string | undefined {
  return item.payload.kind === "AGENT_MESSAGE" ? item.payload.message.message.id : undefined;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
