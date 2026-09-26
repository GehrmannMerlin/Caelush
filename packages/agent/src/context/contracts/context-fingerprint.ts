import { createHash } from "node:crypto";

import type { AIToolSpec, ModelDescriptor } from "@caelush/ai";

import type {
  AgentExecutionIdentity,
  AgentTurnInput,
  AgentTurnRef,
} from "../../loop/types.js";
import type { StoredAgentMessage } from "../../messages/persistence/record.js";
import type { ContextItem } from "../item/context-item.js";
import type { ContextPolicy } from "../policy/context-policy.js";

declare const ContextFingerprintBrand: unique symbol;

export type ContextFingerprint = string & { readonly [ContextFingerprintBrand]: true };

export function createContextFingerprint(value: string): ContextFingerprint {
  if (value.trim().length === 0) throw new TypeError("Context fingerprint must not be empty.");
  return value as ContextFingerprint;
}

export function assertContextFingerprint(value: unknown): asserts value is ContextFingerprint {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError("Context fingerprint must not be empty.");
}

export const CONTEXT_DOCUMENT_RENDERER_VERSION = "1";
export const CONTEXT_MATERIALIZER_VERSION = "1";

export interface ContextFingerprintInput {
  readonly identity: AgentExecutionIdentity;
  readonly turn: AgentTurnRef;
  readonly input?: AgentTurnInput;
  readonly model: ModelDescriptor;
  readonly policy: ContextPolicy;
  readonly selectedItems: readonly ContextItem[];
  readonly conversationMessages: readonly StoredAgentMessage[];
  readonly tools: readonly AIToolSpec[];
  readonly checkpoint?: {
    readonly checkpointId: string;
    readonly checkpointDigest?: string;
  };
  readonly rendererVersion?: string;
  readonly materializerVersion?: string;
}

/** Build the one deterministic, secret-free identity of a target Context build. */
export function buildContextFingerprint(input: ContextFingerprintInput): ContextFingerprint {
  const canonical = stableJson({
    model: {
      ref: input.model.ref,
      api: input.model.api,
      limits: input.model.limits,
      source: input.model.source,
    },
    policy: policyIdentity(input.policy),
    selectedItems: [...input.selectedItems]
      .map((item) => ({
        id: item.id,
        source: item.source,
        type: item.type,
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    messages: input.conversationMessages
      .map((stored) => ({
        messageId: stored.message.id,
        modelProjectionVersion: stored.modelProjectionVersion ?? null,
      }))
      .sort((left, right) => compareStrings(left.messageId, right.messageId)),
    tools: [...input.tools]
      .sort((left, right) => compareStrings(left.name, right.name))
      .map((tool) => tool),
    turn: {
      stepId: input.turn.stepId,
      sequence: input.turn.sequence,
      input: turnIdentity(input.input),
    },
    checkpoint: input.checkpoint ?? null,
    rendererVersion: input.rendererVersion ?? CONTEXT_DOCUMENT_RENDERER_VERSION,
    materializerVersion: input.materializerVersion ?? CONTEXT_MATERIALIZER_VERSION,
  });
  return createContextFingerprint(`sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`);
}

function policyIdentity(policy: ContextPolicy): unknown {
  return {
    contextWindowTokens: policy.contextWindowTokens,
    maxOutputTokens: policy.maxOutputTokens,
    outputReserveTokens: policy.outputReserveTokens,
    safetyReserveTokens: policy.safetyReserveTokens,
    requestOverhead: policy.requestOverhead,
    effectiveInputLimitTokens: policy.effectiveInputLimitTokens,
    proactiveCompactionRatio: policy.proactiveCompactionRatio,
    emergencyCompactionRatio: policy.emergencyCompactionRatio,
    proactiveCompactionTokens: policy.proactiveCompactionTokens,
    emergencyCompactionTokens: policy.emergencyCompactionTokens,
    targetRecentTailTokens: policy.targetRecentTailTokens,
    minRecentTailTokens: policy.minRecentTailTokens,
    observationPolicy: policy.observationPolicy,
    conversationCapTokens: policy.conversationCapTokens,
    sourceLimits: policy.sourceLimits,
    elasticPoolTokens: policy.elasticPoolTokens,
  };
}

function turnIdentity(input: AgentTurnInput | undefined): unknown {
  if (input === undefined) return null;
  switch (input.kind) {
    case "USER_INPUT":
      return { kind: input.kind, userMessageId: input.userMessageId };
    case "TOOL_RESULTS":
      return {
        kind: input.kind,
        sourceStepId: input.sourceStepId,
        toolResultMessageIds: [...input.toolResultMessageIds],
      };
    case "CONTINUATION":
      return { kind: input.kind, reason: input.reason, messageIds: input.messageIds ?? [] };
  }
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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
