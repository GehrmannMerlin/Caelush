import type { BuiltModelContext } from "@caelush/context";
import { LLMRequestSchema, type LLMRequest, type LLMToolChoice } from "@caelush/llm/request";
import type { AgentRun, ToolDefinition } from "@caelush/protocol";
import type { AgentLoopModelSettings } from "./agent-loop-input.js";

export function buildAgentLLMRequest(
  context: BuiltModelContext,
  run: AgentRun,
  tools: readonly ToolDefinition[] | undefined,
  settings: AgentLoopModelSettings | undefined,
): LLMRequest {
  const effectiveTools = tools === undefined || tools.length === 0 ? undefined : [...tools];
  const toolChoice: LLMToolChoice | undefined =
    settings?.toolChoice ?? (effectiveTools === undefined ? undefined : { type: "AUTO" });
  return LLMRequestSchema.parse({
    model: run.model,
    messages: [...context.messages],
    ...(effectiveTools === undefined ? {} : { tools: effectiveTools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(settings?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: settings.maxOutputTokens }),
    ...(settings?.temperature === undefined ? {} : { temperature: settings.temperature }),
  });
}
