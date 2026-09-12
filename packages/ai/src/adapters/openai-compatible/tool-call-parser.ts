import { isJsonObject } from "../../json/json-value.js";
import type { JsonObject } from "../../json/json-value.js";

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
