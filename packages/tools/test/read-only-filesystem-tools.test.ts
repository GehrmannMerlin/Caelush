import { createReadOnlyFilesystemToolRegistrations, ToolRegistryBuilder } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("read-only filesystem registrations", () => {
  it("builds the four tools in the stable model order with strict schemas", () => {
    const registrations = createReadOnlyFilesystemToolRegistrations();
    const registry = registrations
      .reduce((builder, registration) => builder.register(registration), new ToolRegistryBuilder())
      .build();

    expect(registry.names()).toEqual(["read_file", "list_directory", "find_files", "search_text"]);
    for (const name of registry.names()) {
      const definition = registry.resolve(name)?.definition;
      expect(definition?.riskLevel).toBe("LOW");
      expect(definition?.requiredCapabilities).toEqual(["FS_READ"]);
      expect(definition?.inputSchema.additionalProperties).toBe(false);
      expect(definition?.outputSchema.additionalProperties).toBe(false);
    }
  });
});
