import { Buffer } from "node:buffer";
import { isJsonObject } from "../../json/json-value.js";
import type { JsonObject } from "../../json/json-value.js";
import type { AIRejectedToolArgumentsIssue } from "../../tools/received-tool-request.js";

/**
 * Parse the tool input a provider produced, without broad JSON repair.
 *
 * The frozen `AIToolCall.input` contract accepts a JSON object only, so provider
 * quirks are normalised here — inside the adapter — before they cross the adapter
 * boundary. The one sanctioned repair is a trailing comma in an otherwise complete
 * object, which several OpenAI-compatible servers emit.
 *
 * This is deliberately not a general JSON fixer: unquoted keys, incomplete
 * prefixes and truncated objects must fail rather than be guessed, because a
 * guessed tool argument would be executed as if the model had written it.
 */
export function parseOpenAICompatibleToolInput(value: unknown): JsonObject | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return {};

    const parsed = parseJsonObject(text);
    if (parsed !== undefined) return parsed;
    return parseJsonObject(removeTrailingCommas(text));
  }

  return isJsonObject(value) ? value : undefined;
}

/** The parsed outcome of one provider-supplied tool argument value. */
export type OpenAICompatibleToolInputClassification =
  | { readonly kind: "INPUT"; readonly input: JsonObject }
  | { readonly kind: "REJECTED"; readonly issue: AIRejectedToolArgumentsIssue };

/**
 * Classify a provider-supplied argument value, keeping the *reason* a value is unusable.
 *
 * `parseOpenAICompatibleToolInput` answers "is there an object?"; this answers "why not?", which is
 * what a correction needs. The distinction is structural and never textual:
 *
 * ```text
 * a JSON document that is not an object   EXPECTED_OBJECT
 * text that is not JSON at all            MALFORMED_JSON
 * ```
 *
 * `INCOMPLETE_ARGUMENTS` is not produced here. Truncation is a fact about the *turn* — the provider
 * said it stopped because of a length limit — and this function only sees the arguments, so claiming
 * it from a parse failure would be inventing evidence.
 */
export function classifyOpenAICompatibleToolInput(
  value: unknown,
): OpenAICompatibleToolInputClassification {
  if (typeof value === "string") {
    const text = value.trim();
    const argumentBytes = Buffer.byteLength(typeof value === "string" ? value : "", "utf8");
    if (text.length === 0) return { kind: "INPUT", input: {} };

    const direct = parseJsonDocument(text);
    if (direct.kind === "VALUE") {
      return isJsonObject(direct.value)
        ? { kind: "INPUT", input: direct.value }
        : { kind: "REJECTED", issue: { code: "EXPECTED_OBJECT", argumentBytes } };
    }
    const repaired = parseJsonDocument(removeTrailingCommas(text));
    if (repaired.kind === "VALUE") {
      return isJsonObject(repaired.value)
        ? { kind: "INPUT", input: repaired.value }
        : { kind: "REJECTED", issue: { code: "EXPECTED_OBJECT", argumentBytes } };
    }
    return { kind: "REJECTED", issue: { code: "MALFORMED_JSON", argumentBytes } };
  }

  return isJsonObject(value)
    ? { kind: "INPUT", input: value }
    : { kind: "REJECTED", issue: { code: "EXPECTED_OBJECT", argumentBytes: 0 } };
}

type JsonDocument =
  { readonly kind: "VALUE"; readonly value: unknown } | { readonly kind: "FAILED" };

function parseJsonDocument(text: string): JsonDocument {
  try {
    return { kind: "VALUE", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "FAILED" };
  }
}

function parseJsonObject(text: string): JsonObject | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isJsonObject(value) ? value : undefined;
}

/**
 * Remove commas that sit immediately before a closing brace or bracket.
 *
 * String-aware: a comma inside a JSON string literal is copied verbatim, so
 * `{"text":"a,}b"}` is untouched. Nothing else about the document is rewritten —
 * quotes are never inserted, keys are never guessed, and no value is completed.
 */
function removeTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(text[nextIndex] ?? "")) nextIndex += 1;
      if (text[nextIndex] === "}" || text[nextIndex] === "]") continue;
    }
    output += character;
  }

  return output;
}
