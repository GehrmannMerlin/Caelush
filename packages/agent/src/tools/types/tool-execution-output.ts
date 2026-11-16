import {
  WorkflowResourceBindingDraftV1Schema,
  type WorkflowResourceBindingDraftV1,
} from "@caelush/protocol";

import {
  MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS,
  MAX_WORKFLOW_INSTRUCTION_BYTES,
} from "../../context/workflows/workflow-instruction.js";
import type { ToolExecutionIdentity } from "./execution-identity.js";
import type { AgentTool } from "./agent-tool.js";
import type { AgentToolResult } from "./tool-result.js";

export const TOOL_SETTLEMENT_OUTPUT_CAPABILITIES = Object.freeze([
  "WORKFLOW_RESOURCE_BINDING",
] as const);

export type AgentToolSettlementOutputCapability =
  (typeof TOOL_SETTLEMENT_OUTPUT_CAPABILITIES)[number];

export interface AgentToolExecutionOutput {
  readonly result: AgentToolResult;
  readonly preparedResourceBindings?: readonly WorkflowResourceBindingDraftV1[] | undefined;
}

export type AgentToolExecutionReturn = AgentToolResult | AgentToolExecutionOutput;

export type AgentToolExecutionOutputErrorCode =
  "INVALID_EXECUTION_OUTPUT" | "RESOURCE_BINDING_REJECTED";

export class AgentToolExecutionOutputError extends Error {
  constructor(readonly code: AgentToolExecutionOutputErrorCode) {
    super(
      code === "RESOURCE_BINDING_REJECTED"
        ? "Tool resource binding was rejected safely."
        : "Tool execution output is invalid.",
    );
    this.name = "AgentToolExecutionOutputError";
  }
}

/** Validate the closed, data-only capability set at registry construction. */
export function assertAgentToolSettlementOutputCapabilities(
  value: unknown,
): readonly AgentToolSettlementOutputCapability[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1) {
    throw new TypeError("Tool settlement output capabilities are invalid.");
  }
  const capabilities: AgentToolSettlementOutputCapability[] = [];
  for (const candidate of value) {
    if (
      candidate !== "WORKFLOW_RESOURCE_BINDING" ||
      capabilities.includes(candidate as AgentToolSettlementOutputCapability)
    ) {
      throw new TypeError("Tool settlement output capabilities are invalid.");
    }
    capabilities.push(candidate);
  }
  return Object.freeze(capabilities);
}

/** Normalize old result handlers and validate any new internal settlement sidecar. */
export function normalizeAgentToolExecutionOutput(input: {
  readonly value: unknown;
  readonly tool: AgentTool;
  readonly identity: ToolExecutionIdentity;
}): AgentToolExecutionOutput {
  if (!isPlainObject(input.value)) return Object.freeze({ result: input.value as AgentToolResult });

  const keys = Object.keys(input.value);
  const hasEnvelopeKey = keys.includes("result") || keys.includes("preparedResourceBindings");
  if (!hasEnvelopeKey) return Object.freeze({ result: input.value as unknown as AgentToolResult });

  if (
    keys.some((key) => key !== "result" && key !== "preparedResourceBindings") ||
    !Object.prototype.hasOwnProperty.call(input.value, "result")
  ) {
    throw new AgentToolExecutionOutputError(
      Object.prototype.hasOwnProperty.call(input.value, "preparedResourceBindings")
        ? "RESOURCE_BINDING_REJECTED"
        : "INVALID_EXECUTION_OUTPUT",
    );
  }

  const rawBindings = input.value.preparedResourceBindings;
  if (rawBindings === undefined) {
    return Object.freeze({ result: input.value.result as AgentToolResult });
  }
  if (!hasWorkflowResourceBindingCapability(input.tool)) {
    throw new AgentToolExecutionOutputError("RESOURCE_BINDING_REJECTED");
  }

  try {
    const bindings = validateBindings(rawBindings, input.identity);
    const result = input.value.result;
    if (
      !isPlainObject(result) ||
      typeof result.content !== "string" ||
      typeof result.isError !== "boolean" ||
      result.isError
    ) {
      throw new AgentToolExecutionOutputError("RESOURCE_BINDING_REJECTED");
    }
    return Object.freeze({
      result: result as unknown as AgentToolResult,
      preparedResourceBindings: bindings,
    });
  } catch (error) {
    if (error instanceof AgentToolExecutionOutputError) throw error;
    throw new AgentToolExecutionOutputError("RESOURCE_BINDING_REJECTED");
  }
}

function validateBindings(
  value: unknown,
  identity: ToolExecutionIdentity,
): readonly WorkflowResourceBindingDraftV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new AgentToolExecutionOutputError("RESOURCE_BINDING_REJECTED");
  }
  const bindings: WorkflowResourceBindingDraftV1[] = [];
  const identities = new Set<string>();
  let totalBytes = 0;
  let totalTokens = 0;
  for (const candidate of value) {
    const binding = WorkflowResourceBindingDraftV1Schema.parse(candidate);
    if (
      binding.runId !== identity.runId ||
      binding.sourceToolInvocationId !== identity.invocationId ||
      binding.utf8Bytes > MAX_WORKFLOW_INSTRUCTION_BYTES ||
      binding.tokenEstimate > MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS ||
      binding.tokenEstimate !== Math.ceil(binding.utf8Bytes / 3)
    ) {
      throw new AgentToolExecutionOutputError("RESOURCE_BINDING_REJECTED");
    }
    const bindingIdentity = [
      binding.runId,
      binding.resourceKind,
      binding.resourceId,
      binding.resourceRevision,
    ].join("\u0000");
    if (identities.has(bindingIdentity)) {
      throw new AgentToolExecutionOutputError("RESOURCE_BINDING_REJECTED");
    }
    identities.add(bindingIdentity);
    totalBytes += binding.utf8Bytes;
    totalTokens += binding.tokenEstimate;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS * 3 ||
      !Number.isSafeInteger(totalTokens) ||
      totalTokens > MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS
    ) {
      throw new AgentToolExecutionOutputError("RESOURCE_BINDING_REJECTED");
    }
    bindings.push(Object.freeze(binding));
  }
  return Object.freeze(bindings);
}

function hasWorkflowResourceBindingCapability(tool: AgentTool): boolean {
  return tool.settlementOutputCapabilities?.includes("WORKFLOW_RESOURCE_BINDING") === true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
