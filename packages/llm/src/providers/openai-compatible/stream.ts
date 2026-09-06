import { streamText, type TextStreamPart, type ToolSet } from "ai";
import { ToolNameSchema } from "@caelush/protocol";
import { LLMInvalidResponseError } from "../../errors.js";
import type { LLMProviderCallContext, LLMProviderRequest } from "../../provider.js";
import type { LLMStreamEvent } from "../../events.js";
import { LLMToolCallSchema } from "../../tool-call.js";
import { mapFinishReason } from "./finish.js";
import { toAISDKMessages } from "./messages.js";
import { toAISDKToolChoice, toAISDKTools } from "./tools.js";
import { normalizeAISDKUsage } from "./usage.js";
import type { OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { normalizeOpenAICompatibleError } from "./errors.js";
import { assertRawToolCallIdentity, createRawToolCallState } from "./raw-chunk.js";
import { parseOpenAICompatibleToolInput } from "./tool-call-parser.js";

interface ToolLifecycle {
  readonly name: string;
  completed: boolean;
}

export function streamOpenAICompatible(
  upstreamProvider: OpenAICompatibleProvider,
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
): AsyncIterable<LLMStreamEvent> {
  return createStream(upstreamProvider, request, context);
}

async function* createStream(
  upstreamProvider: OpenAICompatibleProvider,
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
): AsyncIterable<LLMStreamEvent> {
  const model = upstreamProvider.chatModel(request.model.model);
  const tools = toAISDKTools(request.tools);
  const toolChoice = toAISDKToolChoice(request.toolChoice);
  const systemMessages = request.messages.filter((message) => message.role === "system");
  const messages = toAISDKMessages(request.messages.filter((message) => message.role !== "system"));
  const instructions =
    systemMessages.length === 0
      ? undefined
      : systemMessages.map((message) => message.content).join("\n\n");
  try {
    const result = streamText({
      model,
      messages,
      ...(instructions === undefined ? {} : { instructions }),
      ...(tools === undefined ? {} : { tools }),
      ...(toolChoice === undefined ? {} : { toolChoice }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      abortSignal: context.signal,
      maxRetries: 0,
      includeRawChunks: true,
      onError: () => undefined,
    });

    yield {
      type: "stream.start",
      payload: {
        callId: context.callId,
        providerId: request.model.provider,
        model: request.model,
      },
    };

    const toolLifecycles = new Map<string, ToolLifecycle>();
    const rawToolCallState = createRawToolCallState();
    for await (const part of result.fullStream) {
      yield* normalizeStreamPart(part, toolLifecycles, rawToolCallState, request, context);
    }
  } catch (error) {
    throw normalizeOpenAICompatibleError(error, request);
  }
}

function* normalizeStreamPart(
  part: TextStreamPart<ToolSet>,
  toolLifecycles: Map<string, ToolLifecycle>,
  rawToolCallState: ReturnType<typeof createRawToolCallState>,
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
): Generator<LLMStreamEvent> {
  switch (part.type) {
    case "raw":
      try {
        assertRawToolCallIdentity(part.rawValue, rawToolCallState);
      } catch {
        throw invalidResponse(
          "OpenAI-compatible stream contained ambiguous tool identity.",
          request,
          context,
        );
      }
      return;
    case "text-delta":
      if (part.text.length > 0) yield { type: "text.delta", payload: { text: part.text } };
      return;
    case "tool-input-start":
      assertToolName(part.toolName, request, context);
      if (toolLifecycles.has(part.id)) {
        throw invalidResponse(
          "OpenAI-compatible stream repeated a tool call id.",
          request,
          context,
        );
      }
      toolLifecycles.set(part.id, { name: part.toolName, completed: false });
      yield {
        type: "tool_call.start",
        payload: { toolCallId: part.id, toolName: part.toolName as `${string}` },
      };
      return;
    case "tool-input-delta": {
      const lifecycle = toolLifecycles.get(part.id);
      if (lifecycle === undefined || lifecycle.completed) {
        throw invalidResponse(
          "OpenAI-compatible stream emitted an inactive tool input delta.",
          request,
          context,
        );
      }
      yield { type: "tool_call.delta", payload: { toolCallId: part.id, delta: part.delta } };
      return;
    }
    case "tool-call": {
      const input = parseOpenAICompatibleToolInput(part.input);
      const parsedCall = LLMToolCallSchema.safeParse({
        id: part.toolCallId,
        name: part.toolName,
        input,
      });
      if (!parsedCall.success) {
        throw invalidResponse(
          "OpenAI-compatible stream returned an invalid tool call.",
          request,
          context,
        );
      }
      const lifecycle = toolLifecycles.get(part.toolCallId);
      if (lifecycle === undefined) {
        toolLifecycles.set(part.toolCallId, { name: parsedCall.data.name, completed: false });
        yield {
          type: "tool_call.start",
          payload: { toolCallId: parsedCall.data.id, toolName: parsedCall.data.name },
        };
        const inputDelta = JSON.stringify(parsedCall.data.input);
        yield {
          type: "tool_call.delta",
          payload: { toolCallId: parsedCall.data.id, delta: inputDelta },
        };
      } else {
        if (lifecycle.completed || lifecycle.name !== parsedCall.data.name) {
          throw invalidResponse(
            "OpenAI-compatible stream changed a completed tool call.",
            request,
            context,
          );
        }
      }
      const current = toolLifecycles.get(parsedCall.data.id);
      if (current === undefined) {
        throw invalidResponse(
          "OpenAI-compatible stream lost a tool call lifecycle.",
          request,
          context,
        );
      }
      current.completed = true;
      yield { type: "tool_call.completed", payload: parsedCall.data };
      return;
    }
    case "finish-step": {
      const usage = normalizeAISDKUsage(part.usage);
      if (usage !== undefined) yield { type: "usage", payload: usage };
      return;
    }
    case "finish": {
      const finalUsage = normalizeAISDKUsage(part.totalUsage);
      yield {
        type: "stream.finish",
        payload: {
          finishReason: mapFinishReason(part.finishReason),
          ...(finalUsage === undefined ? {} : { finalUsage }),
        },
      };
      return;
    }
    case "error":
      throw normalizeOpenAICompatibleError(part.error, request);
    case "abort":
      throw invalidResponse(
        "OpenAI-compatible stream aborted before completion.",
        request,
        context,
      );
    default:
      return;
  }
}

function assertToolName(
  name: string,
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
): void {
  if (!ToolNameSchema.safeParse(name).success) {
    throw invalidResponse(
      "OpenAI-compatible stream returned an invalid tool name.",
      request,
      context,
    );
  }
}

function invalidResponse(
  message: string,
  request: LLMProviderRequest,
  context: LLMProviderCallContext,
): LLMInvalidResponseError {
  void context;
  return new LLMInvalidResponseError(message, {
    providerId: request.model.provider,
    model: request.model,
  });
}
