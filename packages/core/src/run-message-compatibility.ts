import type {
  AIAssistantContent,
  AIAssistantMessage,
  AIMessage,
  AIToolResultMessage,
  AIUserMessage,
} from "@caelush/ai";
import type { JsonObject as AIJsonObject, JsonValue as AIJsonValue } from "@caelush/ai";
import type {
  LLMAssistantContent,
  LLMAssistantMessage,
  LLMMessage,
  LLMToolResultMessage,
  LLMUserMessage,
} from "@caelush/llm/messages";
import type {
  JsonObject as ProtocolJsonObject,
  JsonValue as ProtocolJsonValue,
} from "@caelush/protocol";

/**
 * The Run conversation compatibility codec.
 *
 * ```text
 * AIMessage        the canonical Run domain's model-visible message
 * LLMMessage       the durable encoding the database has always stored
 * ```
 *
 * Phase 3C made the canonical Run execution snapshot speak `AIMessage`, while the persisted bytes
 * stay exactly what they were. This file is the one boundary that translates between them, and it
 * is a *representation* projection only:
 *
 * ```text
 * it never decides a Run status, a retry, a Tool outcome or a completion
 * it never trims context, changes a model or re-orders a conversation
 * it never generates a sequence, a timestamp or a Step identity
 * ```
 *
 * `rawArtifactRef` is the one persisted field with no canonical counterpart. It is a durable
 * artifact-linkage pointer rather than model-visible content, and the frozen AI Tool-result
 * contract carries only `toolCallId`, `toolName`, `content` and `isError`. The durable encoding
 * still *accepts* the pointer and existing rows still hold it; this codec simply has no canonical
 * field to project it into, so {@link toAgentToolResultMessage} drops it and
 * {@link toLegacyToolResultMessage} cannot re-create it. That asymmetry is reported, not hidden —
 * it is a property of the frozen canonical contract, not of this projection.
 *
 * This is not Message System V2. It does not delete `@caelush/llm/messages`, redesign the
 * conversation schema, or migrate any message type.
 */

/** Exhaustiveness guard: a new variant must break the build rather than lose data. */
function assertNever(value: never, what: string): never {
  throw new TypeError(`Unsupported ${what}: ${JSON.stringify(value)}`);
}

/** Project one model-visible AI message onto the durable legacy encoding. */
export function toLegacyDurableMessage(message: AIMessage): LLMMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return toLegacyUserMessage(message);
    case "assistant":
      return toLegacyAssistantMessage(message);
    case "tool":
      return toLegacyToolResultMessage(message);
    default:
      return assertNever(message, "AI message role");
  }
}

/** Project one durable legacy message onto the canonical model-visible AI message. */
export function toAgentAIMessage(message: LLMMessage): AIMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return toAgentUserMessage(message);
    case "assistant":
      return toAgentAssistantMessage(message);
    case "tool":
      return toAgentToolResultMessage(message);
    default:
      return assertNever(message, "durable message role");
  }
}

/* ------------------------------------------------------------ user / system */

export function toLegacyUserMessage(message: AIUserMessage): LLMUserMessage {
  return { role: "user", content: message.content };
}

export function toAgentUserMessage(message: LLMUserMessage): AIUserMessage {
  return { role: "user", content: message.content };
}

/* --------------------------------------------------------------- assistant */

/**
 * Project an assistant message onto the durable encoding.
 *
 * The content array is copied in order and each part is projected in place. Text and tool calls
 * are never regrouped: a durable ledger that reordered them would replay a different request than
 * the one the model answered.
 */
export function toLegacyAssistantMessage(message: AIAssistantMessage): LLMAssistantMessage {
  return {
    role: "assistant",
    content: message.content.map(toLegacyAssistantContent),
  };
}

function toLegacyAssistantContent(part: AIAssistantContent): LLMAssistantContent {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        // The arguments are carried as the same JSON value, never stringified and re-parsed: a
        // round trip through text would be free to change a number, a boolean or a null.
        input: toProtocolJsonObject(part.input),
      };
    default:
      return assertNever(part, "AI assistant content part");
  }
}

export function toAgentAssistantMessage(message: LLMAssistantMessage): AIAssistantMessage {
  return {
    role: "assistant",
    content: message.content.map(toAgentAssistantContent),
  };
}

function toAgentAssistantContent(part: LLMAssistantContent): AIAssistantContent {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: toAIJsonObject(part.input),
      };
    default:
      return assertNever(part, "durable assistant content part");
  }
}

/* ------------------------------------------------------------------ JSON */

/**
 * Project the Protocol JSON value model onto the AI one.
 *
 * The two packages own structurally identical but nominally unrelated JSON types, and a completed
 * tool call's arguments are durable. They are copied member by member — never cast, stringified or
 * re-parsed — so a number, a boolean and a null keep their identity across the boundary.
 */
function toAIJsonObject(value: ProtocolJsonObject): AIJsonObject {
  const projected: Record<string, AIJsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    projected[key] = toAIJsonValue(member);
  }
  return projected;
}

function toAIJsonValue(value: ProtocolJsonValue): AIJsonValue {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toAIJsonValue);
  return toAIJsonObject(value as ProtocolJsonObject);
}

/** Project the AI JSON value model back onto the Protocol one the durable record is written in. */
function toProtocolJsonObject(value: AIJsonObject): ProtocolJsonObject {
  const projected: Record<string, ProtocolJsonValue> = {};
  for (const [key, member] of Object.entries(value)) {
    projected[key] = toProtocolJsonValue(member);
  }
  return projected;
}

function toProtocolJsonValue(value: AIJsonValue): ProtocolJsonValue {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toProtocolJsonValue);
  return toProtocolJsonObject(value as AIJsonObject);
}

/* ------------------------------------------------------------- tool result */

/**
 * Project a Tool result onto the durable encoding.
 *
 * Exactly the four canonical fields are written, so a persisted Tool result always describes the
 * same model-visible observation the canonical domain handed over.
 */
export function toLegacyToolResultMessage(message: AIToolResultMessage): LLMToolResultMessage {
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    isError: message.isError,
  };
}

export function toAgentToolResultMessage(message: LLMToolResultMessage): AIToolResultMessage {
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    isError: message.isError,
  };
}
