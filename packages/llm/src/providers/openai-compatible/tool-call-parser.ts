import { JsonObjectSchema, type JsonObject } from "@caelush/protocol";

/**
 * Parses the provider-facing tool input without broad JSON repair. The public
 * LLM contract only accepts JSON objects, so provider quirks are normalized
 * before they cross the adapter boundary.
 */
export function parseOpenAICompatibleToolInput(value: unknown): JsonObject | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return {};

    const parsed = parseJsonObject(text);
    if (parsed !== undefined) return parsed;
    return parseJsonObject(removeTrailingCommas(text));
  }

  const parsed = JsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseJsonObject(text: string): JsonObject | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = JsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

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
