import { RuntimeInvariantError } from "../runtime-errors.js";
import type { RuntimeTextSearchMatch } from "./text-search.js";

export function parseRipgrepJson(output: string): readonly RuntimeTextSearchMatch[] {
  const matches: RuntimeTextSearchMatch[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new RuntimeInvariantError("ripgrep returned malformed JSON");
    }
    if (!isRecord(value) || value.type !== "match" || !isRecord(value.data)) continue;
    const pathValue = isRecord(value.data.path) ? value.data.path.text : undefined;
    const lineNumber = value.data.line_number;
    const textValue = isRecord(value.data.lines) ? value.data.lines.text : undefined;
    if (
      typeof pathValue !== "string" ||
      typeof lineNumber !== "number" ||
      !Number.isSafeInteger(lineNumber) ||
      lineNumber < 1 ||
      typeof textValue !== "string"
    ) {
      throw new RuntimeInvariantError("ripgrep returned an invalid match event");
    }
    matches.push({
      path: pathValue.replaceAll("\\", "/"),
      line: lineNumber,
      text: textValue.replace(/\r?\n$/, ""),
    });
  }
  return matches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
