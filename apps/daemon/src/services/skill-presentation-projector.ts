import {
  SessionTurnPresentationTurnV4Schema,
  SkillIdSchema,
  SkillPresentationItemSchema,
  UserPresentationItemV4Schema,
  type Observation,
  type SessionTurnPresentationTurnV3,
  type SessionTurnPresentationTurnV4,
  type SkillPresentationItem,
  type ToolInvocation,
  type TurnPresentationItemV4,
} from "@caelush/protocol";
import type { RunSkillPresentationFacts } from "../skills/submission-skill-view.js";

export interface ProjectSkillPresentationTurnInput {
  readonly turn: SessionTurnPresentationTurnV3;
  readonly facts: RunSkillPresentationFacts;
  readonly toolInvocations: readonly ToolInvocation[];
  readonly observations: readonly Observation[];
}

/** Adds safe Skill usage rows to the existing durable-fact session projection. */
export function projectSkillPresentationTurn(
  input: ProjectSkillPresentationTurnInput,
): SessionTurnPresentationTurnV4 {
  const { turn, facts } = input;
  const invocations = input.toolInvocations.filter((item) => item.runId === turn.runId);
  const observationsByInvocation = new Map<string, Extract<Observation, { kind: "TOOL" }>>();
  for (const observation of input.observations) {
    if (observation.kind === "TOOL" && observation.runId === turn.runId) {
      observationsByInvocation.set(String(observation.toolInvocationId), observation);
    }
  }
  const catalogById = new Map(facts.catalogSkills.map((skill) => [skill.skillId, skill] as const));
  const invocationById = new Map(
    invocations.map((invocation) => [String(invocation.id), invocation] as const),
  );
  const bindingInvocationIds = new Set(
    facts.bindings.flatMap(({ sourceToolInvocationId }) =>
      sourceToolInvocationId === undefined ? [] : [String(sourceToolInvocationId)],
    ),
  );
  const boundSkillIds = new Set(facts.bindings.map(({ skillId }) => skillId));
  const byToolInvocation = new Map<string, SkillPresentationItem[]>();
  const openingItems: SkillPresentationItem[] = [];
  const addedBindings = new Set<string>();

  for (const binding of facts.bindings) {
    if (addedBindings.has(binding.bindingId)) continue;
    addedBindings.add(binding.bindingId);
    const sourceInvocation =
      binding.sourceToolInvocationId === undefined
        ? undefined
        : invocationById.get(String(binding.sourceToolInvocationId));
    const cancelled = turn.runStatus === "CANCELLED" && binding.status !== "LOADED";
    const failed = isFailedRun(turn.runStatus) && binding.status !== "LOADED";
    const skillStatus = cancelled || failed ? "FAILED" : binding.status;
    const item = skillItem({
      id: `${turn.runId}:skill:${binding.skillId}`,
      runId: turn.runId,
      conversationTurnId: turn.conversationTurnId,
      createdAt: sourceInvocation?.createdAt ?? firstUserTime(turn) ?? turn.openedAt,
      status: cancelled ? "CANCELLED" : failed ? "FAILED" : "COMPLETED",
      skillId: binding.skillId,
      name: binding.name,
      ...(binding.displayName === undefined ? {} : { displayName: binding.displayName }),
      skillStatus,
    });
    if (binding.sourceToolInvocationId === undefined) openingItems.push(item);
    else append(byToolInvocation, String(binding.sourceToolInvocationId), item);
  }

  for (const invocation of invocations) {
    if (invocation.toolName !== "read_skill" || bindingInvocationIds.has(invocation.id)) continue;
    const parsedSkillId = SkillIdSchema.safeParse(invocation.args.skillId);
    if (!parsedSkillId.success || boundSkillIds.has(parsedSkillId.data)) continue;
    const skill = catalogById.get(parsedSkillId.data);
    if (skill === undefined) continue;
    const observation = observationsByInvocation.get(String(invocation.id));
    const isPending =
      invocation.status === "REQUESTED" ||
      invocation.status === "WAITING_APPROVAL" ||
      invocation.status === "RUNNING";
    const isCancelled = invocation.status === "CANCELLED";
    const item = skillItem({
      id: `${turn.runId}:skill-tool:${invocation.id}`,
      runId: turn.runId,
      conversationTurnId: turn.conversationTurnId,
      createdAt: invocation.createdAt,
      status: isPending ? "STREAMING" : isCancelled ? "CANCELLED" : "FAILED",
      skillId: skill.skillId,
      name: skill.name,
      ...(skill.displayName === undefined ? {} : { displayName: skill.displayName }),
      skillStatus: isPending ? "READING" : "FAILED",
      ...(!isPending && !isCancelled && (observation?.isError ?? true)
        ? { failureReason: "SKILL_LOAD_FAILED" as const }
        : {}),
    });
    append(byToolInvocation, String(invocation.id), item);
  }

  const projected: TurnPresentationItemV4[] = [];
  let openingItemsPlaced = false;
  let selectedSkillsPlaced = false;
  for (const item of turn.items) {
    if (item.kind === "USER") {
      const selectedSkills = selectedSkillsPlaced ? [] : facts.selectedSkills;
      projected.push(
        UserPresentationItemV4Schema.parse({ ...item, selectedSkills }) as TurnPresentationItemV4,
      );
      selectedSkillsPlaced = true;
      if (!openingItemsPlaced) {
        projected.push(...openingItems);
        openingItemsPlaced = true;
      }
    } else {
      projected.push(item);
      if (item.kind === "TOOL") {
        const skillItems = byToolInvocation.get(String(item.toolInvocationId));
        if (skillItems !== undefined) projected.push(...skillItems);
      }
    }
    if (!openingItemsPlaced && projected.length === 1) {
      projected.push(...openingItems);
      openingItemsPlaced = true;
    }
  }
  if (!openingItemsPlaced) projected.push(...openingItems);

  return SessionTurnPresentationTurnV4Schema.parse({
    ...turn,
    items: projected.map((item, ordinal) => ({ ...item, ordinal })),
  });
}

function skillItem(input: {
  readonly id: string;
  readonly runId: SessionTurnPresentationTurnV3["runId"];
  readonly conversationTurnId: string;
  readonly createdAt: SessionTurnPresentationTurnV3["openedAt"];
  readonly status: "STREAMING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly skillId: string;
  readonly name: string;
  readonly displayName?: string;
  readonly skillStatus: "READING" | "CONTENT_READY" | "LOADED" | "FAILED";
  readonly failureReason?: "SKILL_LOAD_FAILED";
}): SkillPresentationItem {
  return SkillPresentationItemSchema.parse({
    id: input.id,
    runId: input.runId,
    conversationTurnId: input.conversationTurnId,
    ordinal: 0,
    createdAt: input.createdAt,
    status: input.status,
    kind: "SKILL",
    skillId: input.skillId,
    name: input.name,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    skillStatus: input.skillStatus,
    ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
  });
}

function append(
  target: Map<string, SkillPresentationItem[]>,
  invocationId: string,
  item: SkillPresentationItem,
): void {
  const items = target.get(invocationId);
  if (items === undefined) target.set(invocationId, [item]);
  else items.push(item);
}

function firstUserTime(turn: SessionTurnPresentationTurnV3) {
  return turn.items.find((item) => item.kind === "USER")?.createdAt;
}

function isFailedRun(status: SessionTurnPresentationTurnV3["runStatus"]): boolean {
  return (
    status === "FAILED" ||
    status === "TIMEOUT" ||
    status === "MAX_STEPS_REACHED" ||
    status === "BUDGET_EXCEEDED"
  );
}
