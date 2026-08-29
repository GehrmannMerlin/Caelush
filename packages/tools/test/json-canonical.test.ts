import { describe, expect, it } from "vitest";
import {
  canonicalJsonString,
  canonicalizeJsonValue,
  jsonUtf8ByteLength,
} from "../src/json-canonical.js";

describe("canonical JSON helpers", () => {
  it("sorts object keys while preserving array order", () => {
    const value = {
      z: 1,
      nested: { b: true, a: "first" },
      array: [{ z: 2, a: 1 }, "second"],
    };

    expect(canonicalizeJsonValue(value)).toEqual({
      array: [{ a: 1, z: 2 }, "second"],
      nested: { a: "first", b: true },
      z: 1,
    });
    expect(canonicalJsonString(value)).toBe(
      '{"array":[{"a":1,"z":2},"second"],"nested":{"a":"first","b":true},"z":1}',
    );
  });

  it("counts UTF-8 bytes rather than JavaScript code units", () => {
    expect(jsonUtf8ByteLength("中文🙂")).toBe(10);
  });

  it("canonicalizes prototype-shaped keys without changing Object.prototype", () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"safe":true}}');
    const before = Object.prototype.hasOwnProperty.call(Object.prototype, "polluted");
    const canonical = canonicalJsonString(value);

    expect(canonical).toContain('"__proto__":{"polluted":true}');
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(before);
  });
});
