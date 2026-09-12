import { describe, expect, it } from "vitest";
import {
  translateOpenAICompatibleToolChoice,
  translateOpenAICompatibleTools,
} from "../../../src/adapters/openai-compatible/tool-translator.js";
import type { AIToolSpec } from "../../../src/tools/tool-spec.js";

const readFile: AIToolSpec = {
  name: "read_file",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

const searchText: AIToolSpec = {
  name: "search_text",
  description: "Search text.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

describe("OpenAI-compatible tool translation", () => {
  it("returns undefined when no tool is declared", () => {
    expect(translateOpenAICompatibleTools(undefined)).toBeUndefined();
    expect(translateOpenAICompatibleTools([])).toBeUndefined();
  });

  it("exposes only name, description and inputSchema", () => {
    const tools = translateOpenAICompatibleTools([readFile]);
    const tool = tools?.["read_file"];

    expect(Object.keys(tools ?? {})).toEqual(["read_file"]);
    expect(Object.keys(tool ?? {}).sort()).toEqual(["description", "inputSchema"]);
    expect(typeof tool?.description).toBe("string");
    // `jsonSchema()` wraps the raw schema; the wrapped JSON is what reaches the wire.
    const schema = tool?.inputSchema as unknown as { jsonSchema?: unknown };
    expect(schema.jsonSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  it("preserves declaration order and never sorts", () => {
    const tools = translateOpenAICompatibleTools([searchText, readFile]);

    expect(Object.keys(tools ?? {})).toEqual(["search_text", "read_file"]);
  });

  it("keeps order stable across repeated translation of the same prefix", () => {
    const first = translateOpenAICompatibleTools([searchText, readFile]);
    const second = translateOpenAICompatibleTools([searchText, readFile]);

    expect(Object.keys(first ?? {})).toEqual(Object.keys(second ?? {}));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("translates every frozen tool choice variant", () => {
    expect(translateOpenAICompatibleToolChoice(undefined)).toBeUndefined();
    expect(translateOpenAICompatibleToolChoice({ type: "AUTO" })).toBe("auto");
    expect(translateOpenAICompatibleToolChoice({ type: "NONE" })).toBe("none");
    expect(translateOpenAICompatibleToolChoice({ type: "REQUIRED" })).toBe("required");
    expect(translateOpenAICompatibleToolChoice({ type: "TOOL", toolName: "read_file" })).toEqual({
      type: "tool",
      toolName: "read_file",
    });
  });
});
