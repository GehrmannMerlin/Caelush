interface OpenAIChunkInput {
  readonly id: string;
  readonly model: string;
  readonly delta: Record<string, unknown>;
  readonly finishReason?: string | null;
  readonly index?: number;
  readonly usage?: Record<string, unknown>;
}

interface ToolCallDeltaInput {
  readonly index?: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

export function openAIChunk(input: OpenAIChunkInput): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: 1,
    model: input.model,
    choices: [
      {
        index: input.index ?? 0,
        delta: input.delta,
        finish_reason: input.finishReason ?? null,
      },
    ],
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  };
}

export function toolCallDelta(input: ToolCallDeltaInput): Record<string, unknown> {
  return {
    ...(input.index === undefined ? {} : { index: input.index }),
    ...(input.id === undefined ? {} : { id: input.id }),
    type: "function",
    function: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
    },
  };
}

export function finishChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly finishReason: string;
  readonly usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return openAIChunk({
    id: input.id,
    model: input.model,
    delta: {},
    finishReason: input.finishReason,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  });
}

export function usageChunk(input: {
  readonly id: string;
  readonly model: string;
  readonly usage: Record<string, unknown>;
}): Record<string, unknown> {
  return openAIChunk({
    id: input.id,
    model: input.model,
    delta: {},
    usage: input.usage,
  });
}

export function sseResponse(chunks: readonly Record<string, unknown>[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
