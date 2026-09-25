import type { AIToolSpec, ModelDescriptor } from "@caelush/ai";

import type { AgentMessage } from "../../messages/index.js";

export interface ContextTokenEstimatorPort {
  estimateText(text: string, model: ModelDescriptor): number;
  estimateAgentMessage(message: AgentMessage, model: ModelDescriptor): number;
  estimateAIToolSpec(tool: AIToolSpec, model: ModelDescriptor): number;
}

/** Provider-neutral UTF-8 estimate used until a host supplies a model tokenizer adapter. */
export class Utf8HeuristicTokenEstimator implements ContextTokenEstimatorPort {
  estimateText(text: string, model: ModelDescriptor): number {
    void model;
    const bytes = new TextEncoder().encode(text).byteLength;
    return bytes === 0 ? 0 : Math.ceil(bytes / 3);
  }

  estimateAgentMessage(message: AgentMessage, model: ModelDescriptor): number {
    return this.estimateText(stableJson(message), model);
  }

  estimateAIToolSpec(tool: AIToolSpec, model: ModelDescriptor): number {
    return this.estimateText(stableJson(tool), model);
  }
}

export function createUtf8HeuristicTokenEstimator(): ContextTokenEstimatorPort {
  return new Utf8HeuristicTokenEstimator();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
