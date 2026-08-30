import { describe, expect, it } from "vitest";
import { analyzeCommand } from "../src/index.js";

function classify(command: string, platform: "POSIX_SH" | "POWERSHELL" | "CMD" = "POSIX_SH") {
  return analyzeCommand({ command, platform, workdir: ".", tty: false }).classifications;
}

describe("input-aware command policy", () => {
  it.each([
    ["npm test", ["NORMAL_LOCAL"]],
    ["git status", ["NORMAL_LOCAL"]],
    ["git add src/app.ts", ["LOCAL_REPO_MUTATION"]],
    ["git reset --hard", ["LOCAL_REPO_MUTATION"]],
    ["rm temp.txt", ["DESTRUCTIVE_LOCAL"]],
    ["rm -rf /", ["SYSTEM_DESTRUCTIVE"]],
    ["curl https://example.com", ["NETWORK_ACCESS"]],
    ["git push origin main", ["NETWORK_ACCESS", "REMOTE_MUTATION"]],
    ["sudo git push", ["NETWORK_ACCESS", "REMOTE_MUTATION", "PRIVILEGE_ESCALATION"]],
  ])("classifies %s", (command, expected) => {
    expect(classify(command)).toEqual(expected);
  });

  it("recursively unwraps POSIX shells and preserves quoted separators", () => {
    expect(classify("bash -lc 'git push origin main && echo \\\"done\\\"'")).toEqual([
      "NETWORK_ACCESS",
      "REMOTE_MUTATION",
    ]);
    expect(classify("printf 'rm -rf /'" )).toEqual(["NORMAL_LOCAL"]);
  });

  it("handles PowerShell and CMD destructive semantics without running them", () => {
    expect(classify("Remove-Item .\\build -Recurse -Force", "POWERSHELL")).toEqual([
      "DESTRUCTIVE_LOCAL",
    ]);
    expect(classify("rmdir /s /q build", "CMD")).toEqual(["DESTRUCTIVE_LOCAL"]);
    expect(classify("Start-Process app.exe -Verb RunAs", "POWERSHELL")).toEqual([
      "PRIVILEGE_ESCALATION",
    ]);
  });

  it("fails closed for dynamic syntax and excessive wrapper depth", () => {
    expect(classify("eval \"git push\"")).toEqual(["OPAQUE_DYNAMIC"]);
    expect(classify("bash -lc \"bash -lc 'bash -lc \\\"bash -lc \\\\\\\"bash -lc \\\\\\\\\\\\\\\"bash -lc \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"echo ok\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\\"\\\\\\\\\\\\\\\"\\\\\\\\\\\\\"\\\\\\\\\\\"\\\\\\\"\\\"'" )).toContain("OPAQUE_DYNAMIC");
  });
});
