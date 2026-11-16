import type { ModelDescriptor } from "@caelush/ai";
import {
  PreparedWorkflowResourceRefV1Schema,
  type PreparedWorkflowResourceRefV1,
} from "@caelush/protocol";

import type { AgentExecutionIdentity, AgentTurnInput, AgentTurnRef } from "../../loop/types.js";
import type { ContextPrepareMode } from "../../loop/context/context-engine-port.js";
import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";
import type { ContextPolicy } from "../policy/context-policy.js";
import type { PreparedWorkflowProjection } from "../workflows/workflow-instruction.js";
import {
  assertWorkflowInstructionFragment,
  WORKFLOW_INSTRUCTION_RENDERER_VERSION,
} from "../workflows/workflow-instruction-renderer.js";
import { assertContextItem, type ContextItem, type ContextSourceId } from "../item/context-item.js";

export interface ContextSourceInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly conversation: AgentConversationSnapshot;
  readonly input: AgentTurnInput;
  readonly model: ModelDescriptor;
  readonly mode: ContextPrepareMode;
  readonly policy: ContextPolicy;
  readonly signal: AbortSignal;
}

export interface ContextSourceDiagnostic {
  readonly code: string;
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly message: string;
  readonly sourceRef?: string;
}

export interface ContextSourceResult {
  readonly providerId: ContextSourceId;
  readonly providerVersion: string;
  readonly items: readonly ContextItem[];
  readonly diagnostics: readonly ContextSourceDiagnostic[];
  /** Present only on the reserved, generic workflow instruction source. */
  readonly preparedWorkflowProjection?: PreparedWorkflowProjection;
}

/** The collection boundary keeps the source result shape until a planner exists. */
export type ContextSourceCollectionResult = ContextSourceResult;

export interface ContextSourceProvider {
  readonly id: ContextSourceId;
  collect(input: ContextSourceInput): Promise<ContextSourceResult>;
}

export type ContextSourceCriticality = "REQUIRED" | "OPTIONAL";

export interface ContextSourceRegistration {
  readonly id: ContextSourceId;
  readonly priority: number;
  readonly criticality: ContextSourceCriticality;
  readonly provider: ContextSourceProvider;
}

export interface ContextSourceRegistry {
  list(): readonly ContextSourceRegistration[];
}

export interface ContextSourceRegistryBuilder {
  register(registration: ContextSourceRegistration): this;
  build(): ContextSourceRegistry;
}

export function assertContextSourceResult(
  value: unknown,
  owner: ContextSourceId,
): asserts value is ContextSourceResult {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Context source result must be an object.");
  const candidate = value as Record<string, unknown>;
  const allowedKeys = ["providerId", "providerVersion", "items", "diagnostics"];
  let preparedWorkflowProjection: PreparedWorkflowProjection | undefined;
  if (candidate.preparedWorkflowProjection !== undefined) {
    if (String(owner) !== "agent.workflow-instructions") {
      throw new TypeError("Prepared workflow projection has an invalid Context source owner.");
    }
    allowedKeys.push("preparedWorkflowProjection");
    assertPreparedWorkflowProjection(candidate.preparedWorkflowProjection);
    preparedWorkflowProjection = candidate.preparedWorkflowProjection;
  }
  assertExactKeys(candidate, allowedKeys);
  if (candidate.providerId !== owner)
    throw new TypeError("Context source result provider ownership is invalid.");
  assertNonEmptyString(candidate.providerVersion, "Context source providerVersion");
  if (!Array.isArray(candidate.items))
    throw new TypeError("Context source result items must be an array.");
  for (const item of candidate.items) {
    assertContextItem(item);
    if (item.source.providerId !== owner)
      throw new TypeError("Context item source ownership is invalid.");
  }
  if (preparedWorkflowProjection !== undefined) {
    if (candidate.items.length !== preparedWorkflowProjection.fragments.length) {
      throw new TypeError("Prepared workflow projection does not match its selected Context items.");
    }
    for (let index = 0; index < candidate.items.length; index += 1) {
      const item = candidate.items[index] as ContextItem;
      const resource = preparedWorkflowProjection.resources[index]!;
      const fragment = preparedWorkflowProjection.fragments[index]!;
      if (
        item.id !== `agent.workflow-instruction:${resource.bindingId}` ||
        item.type !== "agent.workflow-instruction" ||
        item.source.sourceRef !== resource.artifactRef ||
        item.source.version !== resource.rendererVersion ||
        item.retention !== "PINNED" ||
        item.priorityClass !== "CRITICAL" ||
        item.payload.kind !== "TEXT" ||
        item.payload.text !== fragment.text
      ) {
        throw new TypeError("Prepared workflow projection item differs from its Context source.");
      }
    }
  }
  if (!Array.isArray(candidate.diagnostics) || candidate.diagnostics.length > 100)
    throw new TypeError("Context source diagnostics are invalid.");
  for (const diagnostic of candidate.diagnostics) assertDiagnostic(diagnostic);
}

function assertPreparedWorkflowProjection(value: unknown): asserts value is PreparedWorkflowProjection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Prepared workflow projection must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, ["resources", "fragments"]);
  if (
    !Array.isArray(candidate.resources) ||
    !Array.isArray(candidate.fragments) ||
    candidate.resources.length > 100
  ) {
    throw new TypeError("Prepared workflow projection collections are invalid.");
  }
  if (candidate.resources.length !== candidate.fragments.length) {
    throw new TypeError("Prepared workflow projection resources and fragments disagree.");
  }
  const bindingIds = new Set<string>();
  for (let index = 0; index < candidate.resources.length; index += 1) {
    const resource = candidate.resources[index];
    const fragment = candidate.fragments[index];
    if (
      resource === null ||
      typeof resource !== "object" ||
      Array.isArray(resource) ||
      fragment === null ||
      typeof fragment !== "object" ||
      Array.isArray(fragment)
    ) {
      throw new TypeError("Prepared workflow projection entry is invalid.");
    }
    let resourceValue: PreparedWorkflowResourceRefV1;
    const fragmentValue = fragment as Record<string, unknown>;
    try {
      resourceValue = PreparedWorkflowResourceRefV1Schema.parse(resource);
    } catch {
      throw new TypeError("Prepared workflow resource reference is invalid.");
    }
    assertExactKeys(fragmentValue, ["bindingId", "projectionFingerprint", "rendererVersion", "text"]);
    if (
      typeof resourceValue.bindingId !== "string" ||
      typeof resourceValue.projectionFingerprint !== "string" ||
      typeof resourceValue.rendererVersion !== "string" ||
      typeof resourceValue.artifactRef !== "string" ||
      typeof resourceValue.utf8Bytes !== "number" ||
      typeof resourceValue.tokenEstimate !== "number" ||
      fragmentValue.bindingId !== resourceValue.bindingId ||
      fragmentValue.projectionFingerprint !== resourceValue.projectionFingerprint ||
      fragmentValue.rendererVersion !== resourceValue.rendererVersion ||
      typeof fragmentValue.text !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(resourceValue.projectionFingerprint) ||
      resourceValue.rendererVersion !== WORKFLOW_INSTRUCTION_RENDERER_VERSION ||
      bindingIds.has(resourceValue.bindingId)
    ) {
      throw new TypeError("Prepared workflow projection entry identity is invalid.");
    }
    assertWorkflowInstructionFragment(fragmentValue.text as string);
    bindingIds.add(resourceValue.bindingId);
  }
}

function assertDiagnostic(value: unknown): asserts value is ContextSourceDiagnostic {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Context source diagnostic is invalid.");
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, ["code", "severity", "message", "sourceRef"]);
  assertNonEmptyString(candidate.code, "Context source diagnostic code");
  if (
    !(["INFO", "WARNING", "ERROR"] as const).includes(
      candidate.severity as "INFO" | "WARNING" | "ERROR",
    )
  )
    throw new TypeError("Context source diagnostic severity is invalid.");
  assertNonEmptyString(candidate.message, "Context source diagnostic message");
  if (candidate.sourceRef !== undefined)
    assertNonEmptyString(candidate.sourceRef, "Context source diagnostic sourceRef");
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value))
    if (!keys.has(key)) throw new TypeError(`Unexpected Context source field: ${key}.`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${label} must not be empty.`);
}
