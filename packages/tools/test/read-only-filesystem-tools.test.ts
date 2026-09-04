import { createReadOnlyFilesystemToolRegistrations, ToolRegistryBuilder } from "../src/index.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRunId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
  type JsonObject,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { LocalRuntime, createLocalRuntimeResolver } from "@caelush/runtime";

describe("read-only filesystem registrations", () => {
  it("builds the four tools in the stable model order with strict schemas", () => {
    const registrations = createReadOnlyFilesystemToolRegistrations(
      createLocalRuntimeResolver(new LocalRuntime()),
    );
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

  it("uses '.' as the workspace root and rejects absolute paths", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "caelush-list-root-"));
    const workspace = path.join(parent, "workspace");
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, "README.md"), "root\n", "utf8");
      const resolver = createLocalRuntimeResolver(new LocalRuntime());
      const registration = createReadOnlyFilesystemToolRegistrations(resolver)[1]!;
      const environment = {
        workspace: { id: createWorkspaceId(), path: workspace },
        runtime: { id: "local", kind: "local" },
      } as const;
      const request = (args: JsonObject) => ({
        runId: createRunId(),
        stepId: createStepId(),
        invocationId: createToolInvocationId(),
        externalCallId: "list-root",
        args,
        environment,
      });

      await expect(registration.handler.execute(request({ path: "." }))).resolves.toMatchObject({
        isError: false,
        details: { ok: true, path: ".", entries: [{ name: "README.md", path: "README.md" }] },
      });
      await expect(registration.handler.execute(request({ path: workspace }))).resolves.toMatchObject({
        isError: true,
        details: { ok: false, error: "PATH_OUTSIDE_WORKSPACE" },
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
