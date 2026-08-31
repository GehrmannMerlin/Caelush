import { RuntimeBoundaryError, RuntimePathNotFoundError } from "@caelush/runtime";
import { describe, expect, it } from "vitest";
import { createRuntimeWorkspaceVerificationPort } from "../src/verification-runtime-adapters.js";

describe("runtime workspace verification adapter", () => {
  it("uses the existing workspace path resolver and returns metadata only", async () => {
    const calls: string[] = [];
    const port = createRuntimeWorkspaceVerificationPort({
      pathResolver: {
        resolveExisting: async (path) => {
          calls.push(path);
          return {
            absolutePath: `/repo/${path}`,
            realPath: `/repo/${path}`,
            relativePath: path,
            kind: "FILE",
            metadata: { kind: "FILE", sizeBytes: 12 },
          };
        },
      },
    });
    const facts = await port.inspect({
      workspace: { id: "ws_019a0000-0000-7000-8000-000000000000", path: "/repo" },
      changedFiles: [{ path: "src/index.ts", changeType: "MODIFIED" }],
    });
    expect(calls).toEqual(["src/index.ts"]);
    expect(facts).toEqual({
      inspectionComplete: true,
      paths: [{ path: "src/index.ts", kind: "FILE" }],
    });
  });

  it("maps missing and containment failures without reading file contents", async () => {
    const port = createRuntimeWorkspaceVerificationPort({
      pathResolver: {
        resolveExisting: async (path) => {
          if (path === "missing.ts") throw new RuntimePathNotFoundError("missing");
          throw new RuntimeBoundaryError("outside");
        },
      },
    });
    await expect(
      port.inspect({
        workspace: { id: "ws_019a0000-0000-7000-8000-000000000000", path: "/repo" },
        changedFiles: [
          { path: "missing.ts", changeType: "CREATED" },
          { path: "outside.ts", changeType: "MODIFIED" },
        ],
      }),
    ).resolves.toEqual({
      inspectionComplete: true,
      paths: [
        { path: "missing.ts", kind: "MISSING" },
        { path: "outside.ts", kind: "OUTSIDE" },
      ],
    });
  });
});
