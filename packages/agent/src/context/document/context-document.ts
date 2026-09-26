import type {
  ContextCacheStability,
  ContextFreshness,
  ContextPriorityClass,
  ContextSensitivity,
} from "../item/context-item.js";
import type { ContextPlan } from "../policy/context-policy.js";
import type { RehydratedContextState } from "../contracts/rehydrated-context-state.js";
import { assertContextPlan } from "../planner/context-planner.js";

export type ContextSectionAuthority =
  | "CORE_POLICY"
  | "GLOBAL_INSTRUCTION"
  | "PROJECT_INSTRUCTION"
  | "RUNTIME_FACT"
  | "RECOVERY_RECORD"
  | "REFERENCE"
  | "DIAGNOSTIC";

export interface ContextDocumentSection {
  readonly id: string;
  readonly authority: ContextSectionAuthority;
  readonly sourceRef: string;
  readonly cacheStability: ContextCacheStability;
  readonly priorityClass: ContextPriorityClass;
  readonly freshness: ContextFreshness;
  readonly sensitivity: ContextSensitivity;
  readonly text: string;
}

export interface ContextDocument {
  readonly sections: readonly ContextDocumentSection[];
}

export interface ContextDocumentBuilder {
  build(input: {
    readonly plan: ContextPlan;
    readonly rehydrated: RehydratedContextState;
  }): ContextDocument;
}

export class ContextDocumentConstructionError extends Error {
  readonly code = "INVALID_DOCUMENT_CONSTRUCTION" as const;
  readonly itemId?: string;

  constructor(itemId?: string) {
    super("The ContextDocument could not be constructed from the ContextPlan.");
    this.name = "ContextDocumentConstructionError";
    if (itemId !== undefined) this.itemId = itemId;
  }
}

/** Build a semantic document without discovering sources or materializing provider messages. */
export function createContextDocumentBuilder(): ContextDocumentBuilder {
  return Object.freeze({
    build(input: {
      readonly plan: ContextPlan;
      readonly rehydrated: RehydratedContextState;
    }): ContextDocument {
      try {
        assertContextPlan(input.plan);
        assertRehydratedShape(input.rehydrated);
        const sections = [
          ...input.plan.selectedItems.map(toSection),
          ...(hasCurrentAuthority(input.rehydrated) ? authoritySections(input.rehydrated) : []),
        ];
        const planOrder = new Map(sections.map((section, index) => [section.id, index]));
        sections.sort((left, right) => compareSections(left, right, planOrder));
        return Object.freeze({
          sections: Object.freeze(
            sections.map((section: ContextDocumentSection) => Object.freeze(section)),
          ),
        });
      } catch (error) {
        if (error instanceof ContextDocumentConstructionError) throw error;
        throw new ContextDocumentConstructionError();
      }
    },
  });
}

function toSection(item: ContextPlan["selectedItems"][number]): ContextDocumentSection {
  return {
    id: item.id,
    authority: authorityForType(item.type),
    sourceRef: `${item.source.providerId}@${item.source.version}:${item.source.sourceRef}`,
    cacheStability: item.cacheStability,
    priorityClass: item.priorityClass,
    freshness: item.freshness,
    sensitivity: item.sensitivity,
    text: semanticText(item),
  };
}

function authorityForType(type: string): ContextSectionAuthority {
  if (type === "agent.goal" || type === "agent.extension" || type === "agent.core-policy")
    return "CORE_POLICY";
  if (type === "agent.checkpoint") return "RECOVERY_RECORD";
  if (type === "coding.project_instruction") return "PROJECT_INSTRUCTION";
  if (
    type === "coding.workspace" ||
    type === "coding.runtime_fact" ||
    type === "coding.git_state" ||
    type === "coding.temporal"
  ) {
    return "RUNTIME_FACT";
  }
  if (type === "coding.verification_repair") return "DIAGNOSTIC";
  if (
    type === "coding.project_metadata" ||
    type === "coding.relevant_file" ||
    type === "coding.skill_catalog"
  ) {
    return "REFERENCE";
  }
  if (type === "agent.conversation" || type === "agent.memory") return "REFERENCE";
  return "REFERENCE";
}

function semanticText(item: ContextPlan["selectedItems"][number]): string {
  switch (item.payload.kind) {
    case "TEXT":
      return item.payload.text;
    case "ARTIFACT_REFERENCE":
      return item.payload.preview ?? `artifact:${item.payload.artifactId}`;
    case "CHECKPOINT":
      return `RECOVERY SUMMARY (NON-AUTHORITATIVE): ${stableJson(item.payload.checkpoint)}`;
    case "AGENT_MESSAGE":
      return agentMessageText(item.payload.message.message);
  }
}

function agentMessageText(message: {
  readonly type: string;
  readonly content?: readonly {
    readonly type: string;
    readonly text?: string;
    readonly artifactId?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
  }[];
  readonly projectedContent?: string;
}): string {
  if (message.type === "TOOL_RESULT") return message.projectedContent ?? "";
  return (message.content ?? [])
    .map((part) => {
      if (part.type === "TEXT") return part.text ?? "";
      if (part.type === "ATTACHMENT_REF") return `[attachment:${part.artifactId ?? "unknown"}]`;
      if (part.type === "TOOL_CALL")
        return `[tool:${part.toolName ?? "unknown"}:${part.toolCallId ?? "unknown"}]`;
      return "";
    })
    .join("");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareSections(
  left: ContextDocumentSection,
  right: ContextDocumentSection,
  planOrder: ReadonlyMap<string, number>,
): number {
  return (
    cacheStabilityRank(left.cacheStability) - cacheStabilityRank(right.cacheStability) ||
    authorityRank(left.authority) - authorityRank(right.authority) ||
    (planOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (planOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
    compareStrings(left.sourceRef, right.sourceRef) ||
    compareStrings(left.id, right.id)
  );
}

function cacheStabilityRank(value: ContextCacheStability): number {
  return value === "STABLE" ? 0 : value === "SEMI_STABLE" ? 1 : 2;
}

function authorityRank(value: ContextSectionAuthority): number {
  return [
    "CORE_POLICY",
    "GLOBAL_INSTRUCTION",
    "PROJECT_INSTRUCTION",
    "RUNTIME_FACT",
    "RECOVERY_RECORD",
    "REFERENCE",
    "DIAGNOSTIC",
  ].indexOf(value);
}

function assertRehydratedShape(value: RehydratedContextState): void {
  if (
    typeof value.goal !== "string" ||
    !Array.isArray(value.changedFiles) ||
    !Array.isArray(value.pendingApprovals) ||
    !Array.isArray(value.activeProcesses) ||
    typeof value.verificationState !== "string" ||
    typeof value.resourceGovernance !== "string" ||
    !Array.isArray(value.projectFacts)
  ) {
    throw new ContextDocumentConstructionError();
  }
}

function hasCurrentAuthority(value: RehydratedContextState): boolean {
  return (
    value.goal.length > 0 ||
    value.changedFiles.length > 0 ||
    value.pendingApprovals.length > 0 ||
    value.activeProcesses.length > 0 ||
    value.verificationState.length > 0 ||
    value.resourceGovernance.length > 0 ||
    value.projectFacts.length > 0
  );
}

function authoritySections(value: RehydratedContextState): readonly ContextDocumentSection[] {
  return [
    authoritySection("goal", "CORE_POLICY", value.goal),
    authoritySection("changed-files", "RUNTIME_FACT", value.changedFiles),
    authoritySection("pending-approvals", "RUNTIME_FACT", value.pendingApprovals),
    authoritySection("active-processes", "RUNTIME_FACT", value.activeProcesses),
    authoritySection("verification", "DIAGNOSTIC", value.verificationState),
    authoritySection("resource-governance", "RUNTIME_FACT", value.resourceGovernance),
    authoritySection("project-facts", "RUNTIME_FACT", value.projectFacts),
  ];
}

function authoritySection(
  field: string,
  authority: ContextSectionAuthority,
  value: string | readonly string[],
): ContextDocumentSection {
  const rendered = typeof value === "string" ? value : stableJson(value);
  return {
    id: `authority.current.${field}`,
    authority,
    sourceRef: `authority:current:${field}`,
    cacheStability: "DYNAMIC",
    priorityClass: "NORMAL",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    text: `AUTHORITATIVE CURRENT STATE — ${field}: ${rendered}`,
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
