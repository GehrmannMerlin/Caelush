import { describe, expect, it } from "vitest";
import { ToolSchemaRuntime } from "../src/schema-runtime.js";

const runtime = new ToolSchemaRuntime();

describe("ToolSchemaRuntime", () => {
  it("validates without coercion, defaults, removal, or input mutation", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    };
    const validator = runtime.compile(schema);
    const input = { count: "5" };

    expect(validator.validate(input)).toMatchObject({ valid: false });
    expect(input).toEqual({ count: "5" });
    expect(validator.validate({ count: 5 })).toEqual({ valid: true });
    expect(validator.validate({ count: 5, extra: true })).toMatchObject({ valid: false });
  });

  it("supports local definitions and caps validation issues without raw data", () => {
    const validator = runtime.compile({
      $defs: { value: { type: "string" } },
      type: "object",
      properties: {
        first: { $ref: "#/$defs/value" },
        second: { $ref: "#/$defs/value" },
      },
      required: ["first", "second"],
      additionalProperties: false,
    });
    const secret = "CAELUSH_TOOL_SECRET_42";
    const result = validator.validate({ first: 1, second: secret });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeLessThanOrEqual(16);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.issues[0]).toEqual(
        expect.objectContaining({ instancePath: "/first", keyword: "type" }),
      );
    }
  });

  it.each([
    ["remote ref", { type: "object", $ref: "https://example.com/schema.json" }],
    ["file ref", { type: "object", $ref: "file:///tmp/schema.json" }],
    ["async schema", { type: "object", $async: true }],
    ["unknown keyword", { type: "object", additionalProperties: false, unknownKeyword: true }],
  ])("rejects %s at compile time", (_label, schema) => {
    expect(() => runtime.compile(schema)).toThrow();
  });
});
