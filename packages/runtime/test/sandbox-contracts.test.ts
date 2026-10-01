import { describe, expect, it } from "vitest";
import { createWorkspaceId } from "@caelush/protocol";
import { assertRuntimeWorkspaceBoundary, createRuntimeProcessPolicy } from "../src/index.js";

describe("Runtime security boundary contracts", () => {
  it("keeps the authorization policy JSON-safe and binds it to one workspace", () => {
    const policy = createRuntimeProcessPolicy({
      runId: "run_runtime_contract" as never,
      workspaceId: createWorkspaceId(),
      workspaceRoot: "C:\\workspaces\\demo",
      filesystemBoundary: "WORKSPACE_READ_WRITE",
      processBoundary: "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
    });

    expect(JSON.parse(JSON.stringify(policy))).toMatchObject({
      filesystem: {
        workspaceRoot: "C:\\workspaces\\demo",
        boundary: "WORKSPACE_READ_WRITE",
      },
      processBoundary: "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
    });
  });

  it("rejects a working directory outside the authorized workspace", () => {
    const policy = createRuntimeProcessPolicy({
      runId: "run_runtime_boundary" as never,
      workspaceId: createWorkspaceId(),
      workspaceRoot: "C:\\workspaces\\demo",
      filesystemBoundary: "WORKSPACE_READ_WRITE",
      processBoundary: "WORKSPACE_WRITE",
      requiredEnforcement: "OS_RESTRICTED",
    });

    expect(() => assertRuntimeWorkspaceBoundary(policy, "C:\\Users\\other")).toThrow(/workspace/i);
    expect(() => assertRuntimeWorkspaceBoundary(policy, "C:\\workspaces\\demo\\src")).not.toThrow();
  });
});
