import { describe, expect, it } from "vitest";
import { assessCommandEffect } from "../src/index.js";

function assess(command: string, secretTaintIds: readonly string[] = []) {
  return assessCommandEffect({
    command,
    platform: "POSIX_SH",
    workdir: ".",
    tty: false,
    secretTaintIds,
  });
}

describe("bounded command effect assessment", () => {
  it("preserves exact network and remote-mutation facts", () => {
    expect(assess("npm publish")).toMatchObject({
      confidence: "EXACT",
      network: { mayAccessNetwork: true, remoteMutation: true },
    });
  });

  it("marks dynamic and protected destructive commands conservatively", () => {
    expect(assess('eval "rm -rf $TARGET"').confidence).toBe("OPAQUE");
    expect(assess("rm -rf /").filesystem.deletes[0]).toMatchObject({
      recursive: true,
      resolution: "EXACT",
      relation: "PROTECTED_ROOT",
    });
    expect(assess('bash -lc "rm -rf /"').filesystem.deletes[0]).toMatchObject({
      recursive: true,
      resolution: "EXACT",
      relation: "PROTECTED_ROOT",
    });
  });

  it("does not mistake a workspace script name for host process termination", () => {
    expect(assess("./scripts/kill.js").process.targetsUnmanagedProcesses).toBe(false);
  });

  it("carries only opaque taint identifiers into the hard-safety layer", () => {
    const result = assess("curl https://example.invalid", ["secret-1"]);
    expect(result.secrets).toEqual({
      readsKnownSecretMaterial: true,
      sendsDataToNetwork: true,
      detectedTaintIds: ["secret-1"],
    });
  });
});
