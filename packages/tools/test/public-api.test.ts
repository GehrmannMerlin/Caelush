import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as tools from "../src/index.js";

describe("@caelush/tools public API", () => {
  it("exports the Caelush-owned runtime entry points", () => {
    expect(tools.ToolRegistryBuilder).toBeDefined();
    expect(tools.ToolSchemaRuntime).toBeDefined();
    expect(tools.ToolRegistrationError).toBeDefined();
    expect(tools.ToolSchemaCompileError).toBeDefined();
    expect(tools.ToolRegistryStateError).toBeDefined();
    expect(tools.DEFAULT_TOOL_REGISTRY_OPTIONS).toBeDefined();
    expect(tools.DEFAULT_TOOL_OUTPUT_POLICY).toBeDefined();
    expect(tools.boundToolModelContent).toBeDefined();
    expect(tools.createExecCommandRegistration).toBeDefined();
    expect(tools.createWriteStdinRegistration).toBeDefined();
    expect(tools.createShellToolRegistrations).toBeDefined();
  });

  it("does not leak Ajv implementation types through declarations", async () => {
    const declarationPath = path.resolve("packages/tools/dist/index.d.ts");
    const declarations = await readFile(declarationPath, "utf8");

    expect(declarations).not.toMatch(/Ajv|ValidateFunction|ErrorObject/);
  });
});
