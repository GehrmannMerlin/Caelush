import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseOpenAICompatibleToolInput } from "./tool-call-parser.js";
import type { JsonObject } from "../../json/json-value.js";
import type { AIAdapterPrivateCompletionCandidate } from "../../stream/private-completion.js";
import type { ResolvedProviderConnection } from "../../providers/resolved-provider-connection.js";

export const DEEPSEEK_REPLAY_VERSION = 1 as const;
export const DEEPSEEK_REPLAY_API = "openai-compatible-chat" as const;
const MAX_PRIVATE_REPLAY_BYTES = 8 * 1024 * 1024;
const MAX_PRIVATE_REPLAY_TOOL_CALLS = 1024;

export interface DeepSeekNativeReplayPayloadV1 {
  readonly version: typeof DEEPSEEK_REPLAY_VERSION;
  readonly providerId: string;
  readonly model: string;
  readonly api: typeof DEEPSEEK_REPLAY_API;
  readonly connectionFingerprint: string;
  readonly reasoning:
    { readonly state: "ABSENT" } | { readonly state: "PRESENT"; readonly content: string };
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly rawArguments: string;
    readonly argumentMode:
      "PROVIDER_JSON" | "SDK_EMPTY_INPUT_NORMALIZATION" | "SDK_TRAILING_COMMA_NORMALIZATION";
  }[];
}

interface ToolArgumentCapture {
  readonly id: string;
  readonly name: string;
  readonly chunks: string[];
  bytes: number;
  completed: boolean;
  rawArguments?: string;
  argumentMode?: DeepSeekNativeReplayPayloadV1["toolCalls"][number]["argumentMode"];
}

/** Bounded, linear capture of Provider-native reasoning and raw tool argument deltas. */
export interface DeepSeekPrivateReplayCapture {
  observeRawReasoning(rawValue: unknown): void;
  startTool(id: string, name: string): void;
  appendTool(id: string, delta: string): void;
  completeTool(id: string, name: string, input: JsonObject): void;
  finalize(
    providerId: string,
    model: string,
    connectionFingerprint: string,
  ): AIAdapterPrivateCompletionCandidate;
  dispose(): void;
}

export function createDeepSeekPrivateReplayCapture(options: {
  readonly requireReasoning: boolean;
}): DeepSeekPrivateReplayCapture {
  const reasoningChunks: string[] = [];
  const toolArguments = new Map<string, ToolArgumentCapture>();
  let reasoningPresent = false;
  let bytes = 0;
  let incomplete = false;
  let disposed = false;

  const invalidate = () => {
    if (incomplete || disposed) return;
    incomplete = true;
    reasoningChunks.length = 0;
    toolArguments.clear();
    bytes = 0;
  };

  const addBytes = (value: string): boolean => {
    const length = Buffer.byteLength(value, "utf8");
    if (length > MAX_PRIVATE_REPLAY_BYTES - bytes) {
      invalidate();
      return false;
    }
    bytes += length;
    return true;
  };

  return {
    observeRawReasoning(rawValue) {
      if (incomplete || disposed || !isRecord(rawValue) || !Array.isArray(rawValue.choices)) return;
      if (rawValue.choices.length > 1) {
        invalidate();
        return;
      }
      for (const choice of rawValue.choices) {
        if (!isRecord(choice) || !isRecord(choice.delta)) continue;
        if (choice.index !== undefined && choice.index !== 0) {
          invalidate();
          return;
        }
        if (!Object.hasOwn(choice.delta, "reasoning_content")) continue;
        const reasoning: unknown = choice.delta.reasoning_content;
        // The pinned SDK accepts null placeholders on text/Tool deltas; null supplies no bytes.
        if (reasoning === null) continue;
        if (typeof reasoning !== "string") {
          invalidate();
          return;
        }
        reasoningPresent = true;
        if (reasoning.length === 0) continue;
        if (!addBytes(reasoning)) return;
        reasoningChunks.push(reasoning);
      }
    },
    startTool(id, name) {
      if (incomplete || disposed) return;
      if (
        toolArguments.has(id) ||
        toolArguments.size >= MAX_PRIVATE_REPLAY_TOOL_CALLS ||
        !addBytes(id) ||
        !addBytes(name)
      ) {
        invalidate();
        return;
      }
      toolArguments.set(id, { id, name, chunks: [], bytes: 0, completed: false });
    },
    appendTool(id, delta) {
      if (incomplete || disposed || delta.length === 0) return;
      const current = toolArguments.get(id);
      if (current === undefined || current.completed || !addBytes(delta)) {
        if (current === undefined || current.completed) invalidate();
        return;
      }
      current.chunks.push(delta);
      current.bytes += Buffer.byteLength(delta, "utf8");
    },
    completeTool(id, name, input) {
      if (incomplete || disposed) return;
      const current = toolArguments.get(id);
      if (current === undefined || current.completed || current.name !== name) {
        invalidate();
        return;
      }
      const rawArguments = current.chunks.join("");
      const parsed = parseOpenAICompatibleToolInput(rawArguments);
      if (parsed === undefined || !isDeepStrictEqual(parsed, input)) {
        invalidate();
        return;
      }
      let argumentMode: DeepSeekNativeReplayPayloadV1["toolCalls"][number]["argumentMode"];
      try {
        const direct = JSON.parse(rawArguments) as unknown;
        if (!isDeepStrictEqual(direct, input)) {
          invalidate();
          return;
        }
        argumentMode = "PROVIDER_JSON";
      } catch {
        argumentMode =
          rawArguments.trim().length === 0
            ? "SDK_EMPTY_INPUT_NORMALIZATION"
            : "SDK_TRAILING_COMMA_NORMALIZATION";
      }
      current.completed = true;
      current.rawArguments = rawArguments;
      current.argumentMode = argumentMode;
    },
    finalize(providerId, model, connectionFingerprint) {
      if (incomplete || disposed) return { completeness: "INCOMPLETE" };
      const capturedTools = [...toolArguments.values()];
      const completedTools = capturedTools.filter(isCompletedToolCapture);
      if (
        completedTools.length !== capturedTools.length ||
        (options.requireReasoning && !reasoningPresent)
      ) {
        invalidate();
        return { completeness: "INCOMPLETE" };
      }
      const payload: DeepSeekNativeReplayPayloadV1 = {
        version: DEEPSEEK_REPLAY_VERSION,
        providerId,
        model,
        api: DEEPSEEK_REPLAY_API,
        connectionFingerprint,
        reasoning: reasoningPresent
          ? { state: "PRESENT", content: reasoningChunks.join("") }
          : { state: "ABSENT" },
        toolCalls: completedTools.map((call) => ({
          id: call.id,
          name: call.name,
          rawArguments: call.rawArguments,
          argumentMode: call.argumentMode,
        })),
      };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, "utf8") > MAX_PRIVATE_REPLAY_BYTES) {
        invalidate();
        return { completeness: "INCOMPLETE" };
      }
      return { completeness: "COMPLETE", payload: new TextEncoder().encode(serialized) };
    },
    dispose() {
      disposed = true;
      reasoningChunks.length = 0;
      toolArguments.clear();
      bytes = 0;
      reasoningPresent = false;
    },
  };
}

function isCompletedToolCapture(call: ToolArgumentCapture): call is ToolArgumentCapture & {
  readonly rawArguments: string;
  readonly argumentMode: DeepSeekNativeReplayPayloadV1["toolCalls"][number]["argumentMode"];
} {
  return call.completed && call.rawArguments !== undefined && call.argumentMode !== undefined;
}

export function decodeDeepSeekNativeReplayPayload(
  bytes: Uint8Array,
): DeepSeekNativeReplayPayloadV1 | undefined {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PRIVATE_REPLAY_BYTES) return undefined;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value) || value.version !== DEEPSEEK_REPLAY_VERSION) return undefined;
    if (
      !hasExactKeys(value, [
        "version",
        "providerId",
        "model",
        "api",
        "connectionFingerprint",
        "reasoning",
        "toolCalls",
      ])
    )
      return undefined;
    if (
      typeof value.providerId !== "string" ||
      typeof value.model !== "string" ||
      value.api !== DEEPSEEK_REPLAY_API ||
      typeof value.connectionFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.connectionFingerprint) ||
      !isRecord(value.reasoning) ||
      !Array.isArray(value.toolCalls)
    )
      return undefined;
    if (
      (value.reasoning.state === "ABSENT" && Object.keys(value.reasoning).length !== 1) ||
      (value.reasoning.state === "PRESENT" &&
        (Object.keys(value.reasoning).length !== 2 ||
          typeof value.reasoning.content !== "string")) ||
      (value.reasoning.state !== "ABSENT" && value.reasoning.state !== "PRESENT")
    )
      return undefined;
    for (const call of value.toolCalls) {
      if (
        !isRecord(call) ||
        !hasExactKeys(call, ["id", "name", "rawArguments", "argumentMode"]) ||
        typeof call.id !== "string" ||
        typeof call.name !== "string" ||
        typeof call.rawArguments !== "string" ||
        (call.argumentMode !== "PROVIDER_JSON" &&
          call.argumentMode !== "SDK_EMPTY_INPUT_NORMALIZATION" &&
          call.argumentMode !== "SDK_TRAILING_COMMA_NORMALIZATION")
      )
        return undefined;
    }
    return value as unknown as DeepSeekNativeReplayPayloadV1;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

/** Bind replay to the actual endpoint and protocol profile, without retaining credentials. */
export function deepSeekReplayConnectionFingerprint(
  connection: Pick<ResolvedProviderConnection, "endpoint" | "queryParams" | "compatibility">,
  modelCompatibilityProfile?: unknown,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        endpoint: connection.endpoint,
        queryParams: connection.queryParams,
        providerCompatibility: connection.compatibility ?? null,
        modelCompatibility: modelCompatibilityProfile ?? null,
      }),
    )
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
