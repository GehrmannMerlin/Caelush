import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_REGISTRY_OPTIONS, validateToolRegistryOptions } from "../src/options.js";

describe("tool registry options", () => {
  it("provides the Phase 7A default budgets", () => {
    expect(DEFAULT_TOOL_REGISTRY_OPTIONS).toEqual({
      maxTools: 64,
      maxDescriptionBytes: 8192,
      maxInputSchemaBytes: 5000,
      maxOutputSchemaBytes: 16384,
      maxCatalogBytes: 256 * 1024,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid option value %s",
    (invalidValue) => {
      expect(() =>
        validateToolRegistryOptions({
          ...DEFAULT_TOOL_REGISTRY_OPTIONS,
          maxTools: invalidValue,
        } as never),
      ).toThrow(/positive integer/i);
    },
  );
});
