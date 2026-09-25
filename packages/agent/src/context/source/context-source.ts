import type { ModelDescriptor } from "@caelush/ai";

import type { AgentExecutionIdentity, AgentTurnInput, AgentTurnRef } from "../../loop/types.js";
import type { ContextPrepareMode } from "../../loop/context/context-engine-port.js";
import type { AgentConversationSnapshot } from "../../messages/conversation/conversation-snapshot.js";
import type { ContextPolicy } from "../policy/context-policy.js";
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
  assertExactKeys(candidate, ["providerId", "providerVersion", "items", "diagnostics"]);
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
  if (!Array.isArray(candidate.diagnostics) || candidate.diagnostics.length > 100)
    throw new TypeError("Context source diagnostics are invalid.");
  for (const diagnostic of candidate.diagnostics) assertDiagnostic(diagnostic);
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
