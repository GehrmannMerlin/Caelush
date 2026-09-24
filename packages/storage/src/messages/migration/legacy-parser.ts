import { LegacyMessageParseError } from "../legacy/legacy-llm-message-codec.js";
import type { LegacyMessageParser } from "./legacy-types.js";

/**
 * Parse the historical Message V1 JSON shape for database upgrade only.
 *
 * This parser is deliberately kept below `messages/migration`: no runtime storage reader or writer
 * may depend on the old role-shaped language. The parser validates the complete shape before handing
 * it to the deterministic row converter, so malformed persisted bytes fail the Stage C gate.
 */
export const parseHistoricalLegacyMessage: LegacyMessageParser = (rawDataJson) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawDataJson);
  } catch {
    throw new LegacyMessageParseError();
  }
  if (!isRecord(parsed)) throw new LegacyMessageParseError();

  switch (parsed.role) {
    case "system":
    case "user":
      if (typeof parsed.content !== "string") throw new LegacyMessageParseError();
      return { role: parsed.role, content: parsed.content };
    case "assistant":
      if (!Array.isArray(parsed.content) || parsed.content.length === 0) {
        throw new LegacyMessageParseError();
      }
      if (
        !parsed.content.every((part) => {
          if (!isRecord(part)) return false;
          if (part.type === "text") return typeof part.text === "string";
          return (
            part.type === "tool-call" &&
            typeof part.toolCallId === "string" &&
            part.toolCallId.length > 0 &&
            typeof part.toolName === "string" &&
            part.toolName.length > 0 &&
            isJsonObject(part.input)
          );
        })
      ) {
        throw new LegacyMessageParseError();
      }
      return { role: "assistant", content: parsed.content as never };
    case "tool":
      if (
        typeof parsed.toolCallId !== "string" ||
        parsed.toolCallId.length === 0 ||
        typeof parsed.toolName !== "string" ||
        parsed.toolName.length === 0 ||
        typeof parsed.content !== "string" ||
        typeof parsed.isError !== "boolean"
      ) {
        throw new LegacyMessageParseError();
      }
      return {
        role: "tool",
        toolCallId: parsed.toolCallId,
        toolName: parsed.toolName,
        content: parsed.content,
        isError: parsed.isError,
        ...(typeof parsed.rawArtifactRef === "string" && parsed.rawArtifactRef.length > 0
          ? { rawArtifactRef: parsed.rawArtifactRef }
          : {}),
      };
    default:
      throw new LegacyMessageParseError();
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
