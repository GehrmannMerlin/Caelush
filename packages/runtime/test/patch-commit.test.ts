import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimePatchError, RuntimePatchUncertainError, type PreparedPatch } from "../src/index.js";
import type { PatchMutationFileSystem } from "../src/patch/types.js";
import { commitPatch } from "../src/patch/committer.js";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function version(value: string) {
  return {
    sha256: createHash("sha256").update(bytes(value)).digest("hex"),
    sizeBytes: bytes(value).byteLength,
  };
}

function fakeFilesystem(
  initial: Record<string, string>,
  options: { failOn?: number; corruptRollback?: boolean } = {},
) {
  const files = new Map(Object.entries(initial).map(([file, value]) => [file, bytes(value)]));
  const directories = new Set(Object.keys(initial).map((file) => path.dirname(file)));
  directories.add("C:\\workspace");
  let mutations = 0;
  const fail = () => {
    mutations += 1;
    if (mutations === options.failOn) throw new Error("injected commit failure");
  };
  const filesystem: PatchMutationFileSystem = {
    async readFileBytes(file) {
      const value = files.get(file);
      if (value === undefined) throw new Error("file missing");
      return new Uint8Array(value);
    },
    async getMetadata(file) {
      if (files.has(file)) return { kind: "FILE", sizeBytes: files.get(file)!.byteLength };
      if (directories.has(file)) return { kind: "DIRECTORY" };
      return null;
    },
    async writePatchFile(file, value) {
      fail();
      files.set(file, new Uint8Array(value));
      if (options.corruptRollback && file.endsWith("a.txt")) files.set(file, bytes("corrupt"));
    },
    async removePatchFile(file) {
      fail();
      files.delete(file);
    },
    async movePatchFile(source, destination) {
      fail();
      const value = files.get(source);
      if (value === undefined) throw new Error("source missing");
      files.set(destination, new Uint8Array(value));
      files.delete(source);
    },
    async makePatchDirectory(directory) {
      fail();
      directories.add(directory);
    },
    async removePatchDirectoryIfEmpty(directory) {
      fail();
      directories.delete(directory);
    },
  };
  return { files, filesystem, getMutations: () => mutations };
}

function resolved(absolutePath: string, kind: "FILE" | "DIRECTORY" | null, sizeBytes?: number) {
  return {
    absolutePath,
    relativePath: path.basename(absolutePath),
    metadata: kind === null ? null : { kind, ...(sizeBytes === undefined ? {} : { sizeBytes }) },
  } as const;
}

describe("commitPatch", () => {
  it("guards every source and destination before the first mutation", async () => {
    const a = path.join("C:\\workspace", "a.txt");
    const b = path.join("C:\\workspace", "b.txt");
    const fake = fakeFilesystem({ [a]: "changed", [b]: "old" });
    const prepared: PreparedPatch = {
      preparedBytes: 0,
      changes: [
        {
          operation: { kind: "UPDATE", path: "a.txt", hunks: [] },
          source: resolved(a, "FILE", bytes("original").byteLength),
          beforeBytes: bytes("original"),
          afterBytes: bytes("after"),
          beforeVersion: version("original"),
          afterVersion: version("after"),
          additions: 1,
          deletions: 1,
        },
        {
          operation: { kind: "DELETE", path: "b.txt" },
          source: resolved(b, "FILE", bytes("old").byteLength),
          beforeBytes: bytes("old"),
          beforeVersion: version("old"),
          additions: 0,
          deletions: 1,
        },
      ],
    };
    await expect(commitPatch(prepared, fake.filesystem)).rejects.toThrowError(
      expect.objectContaining({ code: "PATCH_STALE" }),
    );
    expect(fake.getMutations()).toBe(0);
  });

  it("applies changes in order and rolls back the committed prefix on failure", async () => {
    const a = path.join("C:\\workspace", "a.txt");
    const b = path.join("C:\\workspace", "b.txt");
    const fake = fakeFilesystem({ [a]: "a", [b]: "b" }, { failOn: 2 });
    const prepared: PreparedPatch = {
      preparedBytes: 0,
      changes: [
        {
          operation: { kind: "UPDATE", path: "a.txt", hunks: [] },
          source: resolved(a, "FILE", 1),
          beforeBytes: bytes("a"),
          afterBytes: bytes("A"),
          beforeVersion: version("a"),
          afterVersion: version("A"),
          additions: 1,
          deletions: 1,
        },
        {
          operation: { kind: "DELETE", path: "b.txt" },
          source: resolved(b, "FILE", 1),
          beforeBytes: bytes("b"),
          beforeVersion: version("b"),
          additions: 0,
          deletions: 1,
        },
      ],
    };
    await expect(commitPatch(prepared, fake.filesystem)).rejects.toThrowError(
      expect.objectContaining({ code: "PATCH_COMMIT_FAILED_ROLLED_BACK" }),
    );
    expect(new TextDecoder().decode(fake.files.get(a))).toBe("a");
    expect(new TextDecoder().decode(fake.files.get(b))).toBe("b");
  });

  it("fails closed when rollback verification cannot prove exact restoration", async () => {
    const a = path.join("C:\\workspace", "a.txt");
    const fake = fakeFilesystem({ [a]: "a" }, { failOn: 2, corruptRollback: true });
    const prepared: PreparedPatch = {
      preparedBytes: 0,
      changes: [
        {
          operation: { kind: "UPDATE", path: "a.txt", hunks: [] },
          source: resolved(a, "FILE", 1),
          beforeBytes: bytes("a"),
          afterBytes: bytes("A"),
          beforeVersion: version("a"),
          afterVersion: version("A"),
          additions: 1,
          deletions: 1,
        },
      ],
    };
    await expect(commitPatch(prepared, fake.filesystem)).rejects.toBeInstanceOf(
      RuntimePatchUncertainError,
    );
    expect(fake.getMutations()).toBeGreaterThan(0);
  });

  it("returns bounded per-file change details after verified success", async () => {
    const a = path.join("C:\\workspace", "a.txt");
    const fake = fakeFilesystem({});
    const prepared: PreparedPatch = {
      preparedBytes: 1,
      changes: [
        {
          operation: { kind: "ADD", path: "a.txt", lines: ["A"] },
          destination: resolved(a, null),
          afterBytes: bytes("A"),
          afterVersion: version("A"),
          additions: 1,
          deletions: 0,
        },
      ],
    };
    await expect(commitPatch(prepared, fake.filesystem)).resolves.toMatchObject({
      ok: true,
      changeCount: 1,
      changes: [{ kind: "ADD", path: "a.txt", additions: 1, deletions: 0 }],
    });
  });
});
