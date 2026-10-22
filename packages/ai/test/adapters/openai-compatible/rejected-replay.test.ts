import { describe, expect, it } from "vitest";
import { createOpenAICompatibleApiAdapter } from "../../../src/adapters/openai-compatible/index.js";
import {
  decodeDeepSeekNativeReplayPayload,
  deepSeekReplayConnectionFingerprint,
} from "../../../src/adapters/openai-compatible/private-replay.js";
import { modelDescriptor } from "../../support/fixtures.js";
import { finishChunk, openAIChunk, sseResponse } from "../../support/openai-compatible-transport.js";
import type { AIAdapterEvent } from "../../../src/adapters/api-adapter-event.js";
import type { ApiAdapterStreamInput } from "../../../src/adapters/api-adapter.js";
import type { AIAssistantMessage } from "../../../src/messages/message.js";
import type { AIPrivateReplayResolver } from "../../../src/stream/private-completion.js";

/**
 * The native-replay contract for a rejected Tool request.
 *
 * A rejected request is still part of the assistant turn the model produced, so a faithful replay must
 * send the provider the *bytes it actually emitted*. Those bytes are not a JSON object and therefore
 * cannot live in the message; they live in the provider's private artifact, and this test proves the
 * adapter reads them from there and puts them on the wire unchanged.
 */

const API_ID = "openai-compatible-chat";
const PROVIDER = "deepseek";
const MODEL = "deepseek-reasoner";
const GOOD_ARGS = '{"path":"a.ts"}';
const BAD_ARGS = '{"path":';
const ADAPTER_METADATA = { requiresReasoningReplayWithTools: true };

function descriptor() {
  return modelDescriptor({
    ref: { provider: PROVIDER, model: MODEL },
    api: API_ID,
    adapterMetadata: { "openai-compatible": ADAPTER_METADATA },
  });
}

/** The assistant message the durable conversation holds for the mixed turn. */
function assistantMessage(): AIAssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call-good", toolName: "read_file", input: { path: "a.ts" } },
      {
        type: "tool-call-rejected",
        toolCallId: "call-bad",
        toolName: "read_file",
        issue: { code: "MALFORMED_JSON", argumentBytes: Buffer.byteLength(BAD_ARGS, "utf8") },
      },
    ],
    providerState: {
      providerId: PROVIDER,
      api: API_ID,
      version: 1,
      payload: { model: MODEL },
    },
  };
}

/** Run one adapter turn whose history contains the rejected request, capturing the real wire body. */
async function runWithReplay(): Promise<{
  readonly body: Record<string, unknown>;
  readonly events: readonly AIAdapterEvent[];
}> {
  let capturedBody: Record<string, unknown> | undefined;
  const connection = {
    providerId: PROVIDER,
    endpoint: "http://127.0.0.1:4321/v1",
    credentials: { apiKey: "fixture-key" },
    headers: {},
    queryParams: {},
    compatibility: undefined,
    transport: {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return sseResponse([
          openAIChunk({
            id: "c1",
            model: MODEL,
            delta: { reasoning_content: "next private reasoning" },
          }),
          openAIChunk({ id: "c1", model: MODEL, delta: { content: "done" } }),
          finishChunk({ id: "c1", model: MODEL, finishReason: "stop" }),
        ]);
      },
    },
  };
  const model = descriptor();
  // The adapter compares the artifact's fingerprint against the one it derives from this exact
  // connection, so the fixture passes the connection through the same function rather than guessing.
  const payload = {
    version: 1 as const,
    providerId: PROVIDER,
    model: MODEL,
    api: API_ID,
    connectionFingerprint: deepSeekReplayConnectionFingerprint(connection, ADAPTER_METADATA),
    reasoning: { state: "PRESENT" as const, content: "private reasoning" },
    toolCalls: [
      {
        id: "call-good",
        name: "read_file",
        rawArguments: GOOD_ARGS,
        argumentMode: "PROVIDER_JSON" as const,
      },
      {
        id: "call-bad",
        name: "read_file",
        rawArguments: BAD_ARGS,
        argumentMode: "PROVIDER_INVALID_ARGUMENTS" as const,
        rejected: true as const,
      },
    ],
  };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const resolver: AIPrivateReplayResolver = { resolve: async () => encoded };

  const input = {
    model,
    provider: connection,
    request: {
      model,
      messages: [
        { role: "user" as const, content: "read it" },
        assistantMessage(),
        {
          role: "tool" as const,
          toolCallId: "call-good",
          toolName: "read_file",
          content: "1: evidence",
          isError: false,
        },
        {
          role: "tool" as const,
          toolCallId: "call-bad",
          toolName: "read_file",
          content: "This call was rejected before execution.",
          isError: true,
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      settings: {
        maxOutputTokens: 64,
        reasoning: { effective: "OFF" as const },
        cache: { effective: "NONE" as const, mode: "EXACT" as const },
      },
    },
    signal: new AbortController().signal,
    privateReplayResolver: resolver,
    capturePrivateCompletion: () => undefined,
  } as unknown as ApiAdapterStreamInput;

  const events: AIAdapterEvent[] = [];
  for await (const event of createOpenAICompatibleApiAdapter().stream(input)) events.push(event);
  return { body: capturedBody ?? {}, events };
}

describe("rejected tool request replay", () => {
  it("sends the provider the exact bytes it produced, not a repaired object", async () => {
    const { body, events } = await runWithReplay();
    const messages = body["messages"] as readonly Record<string, unknown>[];
    const assistant = messages.find((message) => message["role"] === "assistant");
    const calls =
      (assistant?.["tool_calls"] as
        | readonly { readonly id: string; readonly function: { readonly arguments: string } }[]
        | undefined) ?? [];

    expect(calls.map((call) => call.id)).toEqual(["call-good", "call-bad"]);
    expect(calls[0]!.function.arguments).toBe(GOOD_ARGS);
    // The malformed text is replayed verbatim; `{}` or a repaired prefix would both be a different
    // request from the one the model made.
    expect(calls[1]!.function.arguments).toBe(BAD_ARGS);
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
  });

  it("refuses an artifact whose rejection flag disagrees with its argument mode", () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        providerId: PROVIDER,
        model: MODEL,
        api: API_ID,
        connectionFingerprint: "0".repeat(64),
        reasoning: { state: "ABSENT" },
        toolCalls: [
          {
            id: "x",
            name: "read_file",
            rawArguments: GOOD_ARGS,
            argumentMode: "PROVIDER_INVALID_ARGUMENTS",
            rejected: true,
          },
        ],
      }),
    );
    // A parseable object recorded as a rejection would replay a request the model never made, so the
    // artifact is refused rather than trusted.
    expect(decodeDeepSeekNativeReplayPayload(encoded)).toBeUndefined();
  });

  it("decodes a well-formed artifact that carries a rejected call", () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        providerId: PROVIDER,
        model: MODEL,
        api: API_ID,
        connectionFingerprint: "0".repeat(64),
        reasoning: { state: "ABSENT" },
        toolCalls: [
          {
            id: "x",
            name: "read_file",
            rawArguments: BAD_ARGS,
            argumentMode: "PROVIDER_INVALID_ARGUMENTS",
            rejected: true,
          },
        ],
      }),
    );
    expect(decodeDeepSeekNativeReplayPayload(encoded)?.toolCalls[0]).toMatchObject({
      id: "x",
      argumentMode: "PROVIDER_INVALID_ARGUMENTS",
      rejected: true,
    });
  });
});
