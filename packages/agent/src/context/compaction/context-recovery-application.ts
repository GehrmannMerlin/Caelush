import type { ContextItem } from "../item/context-item.js";
import type { ContextItemDecision, ContextPlan } from "../policy/context-policy.js";
import type { ContextSourceCriticality } from "../source/context-source.js";
import type { ContextRecoveryAction } from "./context-recovery-planner.js";

export interface ContextRecoveryApplicationInput {
  readonly plan: ContextPlan;
  readonly items: readonly ContextItem[];
  readonly actions: readonly ContextRecoveryAction[];
  readonly sourceCriticality: Readonly<Record<string, ContextSourceCriticality>>;
  readonly atomicGroupByItemId?: Readonly<Record<string, string>>;
}

export function contextSourceCriticality(
  registrations: readonly { readonly id: string; readonly criticality: ContextSourceCriticality }[],
): Readonly<Record<string, ContextSourceCriticality>> {
  return Object.freeze(
    Object.fromEntries(
      registrations.map((registration) => [registration.id, registration.criticality]),
    ),
  );
}

/**
 * Apply a recovery planner's bounded source reductions to an existing plan.
 *
 * Recovery does not run the planner a second time: that would make the
 * recovery order implicit and could split an atomic history or ToolProtocol
 * unit. Instead, decisions are changed by whole atomic group, and only
 * selected, non-protected optional groups are eligible.
 */
export function applyContextRecoveryToPlan(input: ContextRecoveryApplicationInput): ContextPlan {
  const groups = groupDecisions(input.plan, input.items, input.atomicGroupByItemId);
  const itemById = new Map(input.items.map((item) => [String(item.id), item]));
  const decisions = new Map(
    input.plan.decisions.map((decision) => [String(decision.itemId), decision]),
  );

  for (const group of groups.values()) {
    if (!group.some((decision) => decision.disposition === "SELECTED")) continue;
    if (isProtectedGroup(group)) continue;
    if (!isOptionalGroup(group, itemById, input.sourceCriticality)) continue;

    const items = group
      .map((decision) => input.items.find((item) => String(item.id) === String(decision.itemId)))
      .filter((item): item is ContextItem => item !== undefined);
    if (items.length !== group.length) continue;

    let replacement: ContextItemDecision | undefined;
    if (
      input.actions.includes("DEFER_LOW_RETRIEVABLE") &&
      items.every((item) => item.retention === "RETRIEVABLE" && item.priorityClass === "LOW")
    ) {
      replacement = {
        ...group[0]!,
        disposition: "DEFERRED",
        reason: "RETRIEVABLE_DEFERRED",
      };
    } else if (input.actions.includes("REDUCE_OPTIONAL_SOURCES")) {
      replacement = {
        ...group[0]!,
        disposition: "DROPPED",
        reason: "TOTAL_BUDGET",
      };
    }
    if (replacement === undefined) continue;
    for (const decision of group) {
      decisions.set(String(decision.itemId), {
        ...decision,
        disposition: replacement.disposition,
        reason: replacement.reason,
      });
    }
  }

  const nextDecisions = [...decisions.values()].sort((left, right) =>
    String(left.itemId).localeCompare(String(right.itemId)),
  );
  const selectedItems = input.plan.selectedItems.filter(
    (item) => decisions.get(String(item.id))?.disposition === "SELECTED",
  );
  const selectedTokens = selectedItems.reduce((total, item) => total + item.tokenEstimate, 0);
  const budget = Object.freeze({
    ...input.plan.budget,
    selectedTokens,
    remainingTokens: Math.max(0, input.plan.budget.effectiveInputLimitTokens - selectedTokens),
  });
  return Object.freeze({
    ...input.plan,
    selectedItems: Object.freeze(selectedItems),
    decisions: Object.freeze(nextDecisions.map((decision) => Object.freeze(decision))),
    budget,
    requiresCompaction: selectedTokens > budget.effectiveInputLimitTokens,
  });
}

function groupDecisions(
  plan: ContextPlan,
  items: readonly ContextItem[],
  atomicGroupByItemId: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, readonly ContextItemDecision[]> {
  const itemById = new Map(items.map((item) => [String(item.id), item]));
  const groups = new Map<string, ContextItemDecision[]>();
  for (const decision of plan.decisions) {
    const item = itemById.get(String(decision.itemId));
    const key =
      item?.atomicGroupId ??
      atomicGroupByItemId?.[String(decision.itemId)] ??
      String(decision.itemId);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [decision]);
    else group.push(decision);
  }
  return groups;
}

function isProtectedGroup(group: readonly ContextItemDecision[]): boolean {
  return group.some((decision) =>
    ["OPEN_PROTOCOL_UNIT", "RECENT", "MANDATORY", "PINNED"].includes(decision.reason),
  );
}

function isOptionalGroup(
  group: readonly ContextItemDecision[],
  itemById: ReadonlyMap<string, ContextItem>,
  sourceCriticality: Readonly<Record<string, ContextSourceCriticality>>,
): boolean {
  return group.every((decision) => {
    const item = itemById.get(String(decision.itemId));
    return item !== undefined && sourceCriticality[String(item.source.providerId)] !== "REQUIRED";
  });
}
