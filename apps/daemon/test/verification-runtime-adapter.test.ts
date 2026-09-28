import {
  RuntimeBinaryFileError,
  RuntimeBoundaryError,
  RuntimePathNotFoundError,
  type RuntimeFileSystem,
} from "@caelush/runtime";
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

  it("includes a missing fingerprint for deleted paths so freshness can be proven", async () => {
    const port = createRuntimeWorkspaceVerificationPort({
      pathResolver: {
        resolveExisting: async () => {
          throw new RuntimePathNotFoundError("deleted");
        },
      },
    });

    await expect(
      port.inspect({
        workspace: { id: "ws_019a0000-0000-7000-8000-000000000000", path: "/repo" },
        changedFiles: [{ path: "removed.tmp", changeType: "DELETED" }],
      }),
    ).resolves.toEqual({
      inspectionComplete: true,
      paths: [{ path: "removed.tmp", kind: "MISSING", fingerprint: { kind: "MISSING" } }],
    });
  });

  it("reads bounded content only from attributed regular files and binds it to a stable fingerprint", async () => {
    const readPaths: string[] = [];
    const fingerprintCalls = new Map<string, number>();
    const filesystem = {
      async fingerprint(path: string) {
        const call = (fingerprintCalls.get(path) ?? 0) + 1;
        fingerprintCalls.set(path, call);
        return { kind: "FILE" as const, sizeBytes: 18, sha256: "a".repeat(64) };
      },
      async readTextFile(
        path: string,
        options: { offset: number; limit: number; maxBytes: number },
      ) {
        readPaths.push(path);
        expect(options).toEqual({ offset: 0, limit: 256, maxBytes: 8 * 1024 });
        if (path.endsWith("binary.class")) {
          throw new RuntimeBinaryFileError("binary");
        }
        return {
          lines: ["1: public class HelloWorld {", "2: }"],
          lineStart: 0,
          bytesReturned: 29,
          truncated: false,
          utf8Bom: false,
        };
      },
    } as unknown as RuntimeFileSystem;
    const port = createRuntimeWorkspaceVerificationPort({
      filesystem,
      pathResolver: {
        resolveExisting: async (path) => ({
          absolutePath: `/repo/${path}`,
          realPath: `/repo/${path}`,
          relativePath: path,
          kind: path === "binary.class" ? ("FILE" as const) : ("FILE" as const),
          metadata: { kind: "FILE" as const, sizeBytes: 18 },
        }),
      },
    });
    const facts = await port.inspect({
      workspace: { id: "ws_019a0000-0000-7000-8000-000000000000", path: "/repo" },
      changedFiles: [
        { path: "binary.class", changeType: "CREATED" },
        { path: "HelloWorld.java", changeType: "CREATED" },
        { path: "unattributed.txt", changeType: "CREATED" },
      ],
    });
    expect(readPaths).toEqual([
      "/repo/binary.class",
      "/repo/HelloWorld.java",
      "/repo/unattributed.txt",
    ]);
    expect(fingerprintCalls.get("/repo/HelloWorld.java")).toBe(2);
    expect(facts.artifactEvidence).toEqual([
      {
        path: "binary.class",
        kind: "BINARY",
        sha256: "a".repeat(64),
        sizeBytes: 18,
        truncated: false,
      },
      {
        path: "HelloWorld.java",
        kind: "TEXT",
        sha256: "a".repeat(64),
        sizeBytes: 18,
        content: "1: public class HelloWorld {\n2: }",
        truncated: false,
      },
      {
        path: "unattributed.txt",
        kind: "TEXT",
        sha256: "a".repeat(64),
        sizeBytes: 18,
        content: "1: public class HelloWorld {\n2: }",
        truncated: false,
      },
    ]);
  });

  it("filters sensitive paths and binary reads without exposing their content", async () => {
    const readPaths: string[] = [];
    const filesystem = {
      async fingerprint() {
        return { kind: "FILE" as const, sizeBytes: 10, sha256: "f".repeat(64) };
      },
      async readTextFile(path: string) {
        readPaths.push(path);
        throw new RuntimeBinaryFileError("binary");
      },
    } as unknown as RuntimeFileSystem;
    const port = createRuntimeWorkspaceVerificationPort({
      filesystem,
      pathResolver: {
        resolveExisting: async (path) => ({
          absolutePath: `/repo/${path}`,
          realPath: `/repo/${path}`,
          relativePath: path,
          kind: "FILE" as const,
          metadata: { kind: "FILE" as const, sizeBytes: 10 },
        }),
      },
    });
    const facts = await port.inspect({
      workspace: { id: "ws_019a0000-0000-7000-8000-000000000000", path: "/repo" },
      changedFiles: [
        { path: ".env", changeType: "CREATED" },
        { path: "image.png", changeType: "CREATED" },
      ],
    });
    expect(readPaths).toEqual(["/repo/image.png"]);
    expect(facts.artifactEvidence).toEqual([
      {
        path: ".env",
        kind: "SENSITIVE",
        sha256: "f".repeat(64),
        sizeBytes: 10,
        truncated: false,
      },
      {
        path: "image.png",
        kind: "BINARY",
        sha256: "f".repeat(64),
        sizeBytes: 10,
        truncated: false,
      },
    ]);
  });
});
