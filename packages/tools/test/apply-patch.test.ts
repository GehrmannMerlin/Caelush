import {
  createRunId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
  type JsonObject,
} from "@caelush/protocol";
import {
  RuntimePatchError,
  RuntimePatchUncertainError,
  type Runtime,
  type RuntimeResolver,
} from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import { createFileMutationToolRegistrations, ToolRegistryBuilder } from "../src/index.js";
import type { ToolExecutionRequest } from "../src/index.js";

const environment = {
  workspace: { id: createWorkspaceId(), path: "C:/workspace" },
  runtime: { id: "local", kind: "local" },
} as const;

function request(args: JsonObject): ToolExecutionRequest {
  return {
    runId: createRunId(),
    stepId: createStepId(),
    invocationId: createToolInvocationId(),
    externalCallId: "call-1",
    args,
    environment,
  };
}

describe("apply_patch Tool registration", () => {
  it("publishes one HIGH-risk strict mutation tool with write/delete capabilities", () => {
    const [registration] = createFileMutationToolRegistrations();
    expect(registration?.definition).toMatchObject({
      name: "apply_patch",
      riskLevel: "HIGH",
      requiredCapabilities: ["FS_WRITE", "FS_DELETE"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    });
    expect(registration?.definition.inputSchema).toMatchObject({
      type: "object",
      required: ["patch"],
      additionalProperties: false,
    });
    const registry = new ToolRegistryBuilder().register(registration!).build();
    expect(registry.names()).toEqual(["apply_patch"]);
  });

  it("maps expected runtime patch errors to bounded model results", async () => {
    const runtime = {
      kind: "local",
      supports: () => true,
      openWorkspace: async () => ({
        patch: {
          apply: async () => {
            throw new RuntimePatchError("INVALID_PATCH");
          },
        },
      }),
    } as unknown as Runtime;
    const resolver: RuntimeResolver = { resolve: () => runtime };
    const [registration] = createFileMutationToolRegistrations(resolver);
    const result = await registration!.handler.execute(request({ patch: "bad" }));
    expect(result).toMatchObject({ isError: true, details: { ok: false, error: "INVALID_PATCH" } });
  });

  it("rethrows runtime uncertainty as a Tool boundary uncertainty", async () => {
    const runtime = {
      kind: "local",
      supports: () => true,
      openWorkspace: async () => ({
        patch: {
          apply: async () => {
            throw new RuntimePatchUncertainError();
          },
        },
      }),
    } as unknown as Runtime;
    const [registration] = createFileMutationToolRegistrations({ resolve: () => runtime });
    await expect(registration!.handler.execute(request({ patch: "bad" }))).rejects.toMatchObject({
      executionDisposition: "UNCERTAIN_SIDE_EFFECT",
    });
  });
});
