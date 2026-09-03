import type { LLMMessage } from "@caelush/llm/messages";
import { estimateLLMMessage } from "./conversation-history.js";
import type { TokenEstimator } from "./token-estimator.js";

export type ExecutionUnitStatus = "OPEN" | "CLOSED";

export interface ExecutionUnit {
  readonly id: string;
  readonly runId: string;
  readonly sourceSequenceFrom: number;
  readonly sourceSequenceTo: number;
  readonly status: ExecutionUnitStatus;
  readonly assistantMessageRef: string;
  readonly toolInvocationIds: readonly string[];
  readonly toolResultRefs: readonly string[];
  readonly tokenEstimate: number;
  readonly createdAt: number;
  readonly closedAt?: number;
}

export interface ExecutionUnitBuildOptions {
  readonly runId: string;
  readonly createdAt: number;
  readonly estimateText: TokenEstimator["estimateText"];
}

export function createExecutionUnit(input: ExecutionUnit): ExecutionUnit {
  if (input.id.trim() === "" || input.runId.trim() === "") {
    throw new RangeError("ExecutionUnit id and runId must not be empty");
  }
  if (
    !Number.isSafeInteger(input.sourceSequenceFrom) ||
    !Number.isSafeInteger(input.sourceSequenceTo) ||
    input.sourceSequenceFrom > input.sourceSequenceTo
  ) {
    throw new RangeError("ExecutionUnit source range is invalid");
  }
  if (!Number.isSafeInteger(input.tokenEstimate) || input.tokenEstimate < 0) {
    throw new RangeError("ExecutionUnit tokenEstimate must be non-negative");
  }
  if (input.status === "CLOSED" && input.closedAt === undefined) {
    throw new RangeError("closed ExecutionUnit requires closedAt");
  }
  return Object.freeze({
    ...input,
    toolInvocationIds: Object.freeze([...input.toolInvocationIds]),
    toolResultRefs: Object.freeze([...input.toolResultRefs]),
  });
}

export function isCompactionCandidate(unit: ExecutionUnit): boolean {
  return unit.status === "CLOSED" && unit.toolInvocationIds.length === unit.toolResultRefs.length;
}

export function buildExecutionUnits(
  messages: readonly LLMMessage[],
  options: ExecutionUnitBuildOptions,
): readonly ExecutionUnit[] {
  const units: ExecutionUnit[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const calls = message.content.filter((part) => part.type === "tool-call");
    if (calls.length === 0) continue;
    const callIds = calls.map((call) => call.toolCallId);
    const resultIds: string[] = [];
    let end = index;
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor];
      if (candidate?.role === "assistant") break;
      if (candidate?.role !== "tool" || !callIds.includes(candidate.toolCallId)) continue;
      resultIds.push(candidate.toolCallId);
      end = cursor;
      if (resultIds.length === callIds.length) break;
    }
    const closed = resultIds.length === callIds.length;
    const sourceMessages = messages.slice(index, end + 1);
    units.push(
      createExecutionUnit({
        id: `${options.runId}:execution:${index}`,
        runId: options.runId,
        sourceSequenceFrom: index,
        sourceSequenceTo: end,
        status: closed ? "CLOSED" : "OPEN",
        assistantMessageRef: `${options.runId}:message:${index}`,
        toolInvocationIds: callIds,
        toolResultRefs: resultIds,
        tokenEstimate: sourceMessages.reduce(
          (total, current) => total + estimateLLMMessage(current, options),
          0,
        ),
        createdAt: options.createdAt,
        ...(closed ? { closedAt: options.createdAt } : {}),
      }),
    );
  }
  return units;
}

export function selectSafeExecutionUnits(
  units: readonly ExecutionUnit[],
  maxTokens: number,
): readonly ExecutionUnit[] {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new RangeError("maxTokens must be a non-negative safe integer");
  }
  const selected: ExecutionUnit[] = [];
  let used = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit === undefined || !isCompactionCandidate(unit)) continue;
    if (used + unit.tokenEstimate > maxTokens) break;
    selected.unshift(unit);
    used += unit.tokenEstimate;
  }
  return selected;
}
