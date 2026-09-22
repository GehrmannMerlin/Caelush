import type { BuiltModelContext } from "@caelush/context";
import { validateAIModelRequest } from "@caelush/ai";
import type { AIModelRequest, AIToolChoice, AIToolSpec, ModelDescriptor } from "@caelush/ai";
import type { AgentRun } from "@caelush/protocol";
import type { AgentLoopModelSettings } from "./agent-loop-input.js";
import { toAIMessage, toAIModelRef } from "./ai-invocation-projection.js";

/**
 * Build the frozen AI model request for one agent turn.
 *
 * This replaces `buildAgentLLMRequest`, which produced a legacy `LLMRequest`. The
 * model execution path now speaks the AI model invocation contract, so the request
 * carries an `AIModelRequest` and `AIModelSettings` and is validated against the
 * resolved `ModelDescriptor`.
 *
 * Tool order is the caller's tool-catalog order and is never sorted, so a stable
 * tool prefix stays byte-identical across turns. An omitted tool choice defaults to
 * `AUTO` exactly when tools are present, and is omitted entirely when they are not.
 *
 * The catalog arrives already in its model-facing form — `AIToolSpec`, three fields — so nothing is
 * projected here. Phase 4F removed the legacy Protocol `ToolDefinition` from this path: a value that is
 * already what the provider receives needs no translation, and a translation would be the one place
 * runtime metadata could be reintroduced into a provider request.
 */
export function buildAgentAIModelRequest(
  context: BuiltModelContext,
  run: AgentRun,
  tools: readonly AIToolSpec[] | undefined,
  settings: AgentLoopModelSettings | undefined,
  descriptor: ModelDescriptor,
): AIModelRequest {
  const effectiveTools = tools === undefined || tools.length === 0 ? undefined : tools;
  const toolChoice: AIToolChoice | undefined =
    settings?.toolChoice ?? (effectiveTools === undefined ? undefined : { type: "AUTO" });

  const request: AIModelRequest = {
    model: toAIModelRef(run.model),
    messages: context.messages.map(toAIMessage),
    ...(effectiveTools === undefined ? {} : { tools: [...effectiveTools] }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(settings?.maxOutputTokens === undefined && settings?.temperature === undefined
      ? {}
      : {
          settings: {
            ...(settings?.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: settings.maxOutputTokens }),
            ...(settings?.temperature === undefined ? {} : { temperature: settings.temperature }),
          },
        }),
  };

  // Cross-field semantic validation against the resolved model: tool semantics,
  // capability rejection and the model's output ceiling.
  validateAIModelRequest(request, descriptor);
  return request;
}
