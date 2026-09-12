import { describe, expect, it } from "vitest";
import { parseOpenAICompatibleToolInput } from "../../../src/adapters/openai-compatible/tool-call-parser.js";

describe("OpenAI-compatible tool input parsing", () => {
  it("accepts an already-parsed JSON object", () => {
    expect(parseOpenAICompatibleToolInput({ path: "a.ts" })).toEqual({ path: "a.ts" });
    expect(parseOpenAICompatibleToolInput({})).toEqual({});
    expect(parseOpenAICompatibleToolInput({ nested: { list: [1, "two", null, true] } })).toEqual({
      nested: { list: [1, "two", null, true] },
    });
  });

  it("parses a JSON object string", () => {
    expect(parseOpenAICompatibleToolInput('{"path":"src/index.ts"}')).toEqual({
      path: "src/index.ts",
    });
    expect(parseOpenAICompatibleToolInput('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it("treats an empty or whitespace string as an empty argument object", () => {
    expect(parseOpenAICompatibleToolInput("")).toEqual({});
    expect(parseOpenAICompatibleToolInput("   ")).toEqual({});
  });

  it("repairs a single trailing comma in a complete argument object", () => {
    expect(parseOpenAICompatibleToolInput('{"path":"a.ts",}')).toEqual({ path: "a.ts" });
    expect(parseOpenAICompatibleToolInput('{"list":[1,2,],}')).toEqual({ list: [1, 2] });
  });

  it("does not remove a comma-like sequence inside a JSON string", () => {
    expect(parseOpenAICompatibleToolInput('{"text":"a,}b"}')).toEqual({ text: "a,}b" });
    expect(parseOpenAICompatibleToolInput('{"text":"x,\\"}y"}')).toEqual({ text: 'x,"}y' });
  });

  it("never guesses unquoted keys or completes a prefix", () => {
    expect(parseOpenAICompatibleToolInput("{path:1}")).toBeUndefined();
    expect(parseOpenAICompatibleToolInput('{"path"')).toBeUndefined();
    expect(parseOpenAICompatibleToolInput('{"path":"a.ts"')).toBeUndefined();
    expect(parseOpenAICompatibleToolInput('{"path":"a.ts",')).toBeUndefined();
  });

  it("rejects values that are not a JSON object", () => {
    for (const value of [
      undefined,
      null,
      "not json",
      "[1,2]",
      '"text"',
      "42",
      [1, 2],
      { bad: undefined },
      { bad: Number.NaN },
      { bad: () => undefined },
      new Date(),
    ]) {
      expect(
        parseOpenAICompatibleToolInput(value),
        JSON.stringify(value) ?? "undefined",
      ).toBeUndefined();
    }
  });

  it("rejects an array even though it is an object at runtime", () => {
    // `AIToolCall.input` is a JsonObject, so an array is never a valid tool input.
    expect(parseOpenAICompatibleToolInput([])).toBeUndefined();
    expect(parseOpenAICompatibleToolInput("[]")).toBeUndefined();
  });
});
