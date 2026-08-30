import { describe, expect, it } from "vitest";
import {
  createDefaultBuiltinToolRegistrations,
  type ToolSecurityFactsProjector,
} from "../src/index.js";

const resolver = { resolve: () => undefined };

function projector(name: string): ToolSecurityFactsProjector {
  const registration = createDefaultBuiltinToolRegistrations(resolver).find(
    ({ definition }) => definition.name === name,
  );
  if (registration?.securityFactsProjector === undefined) {
    throw new Error(`missing projector for ${name}`);
  }
  return registration.securityFactsProjector;
}

describe("built-in Tool Security Facts projectors", () => {
  it("projects resource paths and secret inputs for read/search/git tools", () => {
    expect(projector("read_file")({ path: "src\\App.ts" })).toMatchObject({
      resourceAccesses: [{ operation: "READ", path: "src/App.ts" }],
    });
    expect(projector("search_text")({ pattern: "TOKEN", path: ".", include: "*.ts" })).toMatchObject({
      resourceAccesses: [{ operation: "SEARCH", path: "." }],
      secretScanInputs: [{ kind: "GENERIC", text: "TOKEN" }],
    });
    expect(projector("git_diff")({ scope: "WORKTREE", path: ".env" })).toMatchObject({
      resourceAccesses: [{ operation: "DIFF", path: ".env" }],
    });
  });

  it("does not expose stdin or patch bodies in structural previews", () => {
    const stdin = projector("write_stdin")({ session_id: "session-1", chars: "secret input" });
    expect(stdin.structuralPreview).toEqual({ kind: "PROCESS_INPUT", sessionId: "session-1", inputBytes: 12 });
    expect(JSON.stringify(stdin.structuralPreview)).not.toContain("secret input");

    const patch = projector("apply_patch")({
      patch: `*** Begin Patch\n*** Add File: .env\n+API_KEY=secret\n*** End Patch`,
    });
    expect(patch.resourceAccesses).toEqual([{ operation: "WRITE", path: ".env" }]);
    expect(JSON.stringify(patch.structuralPreview)).not.toContain("API_KEY=secret");
    expect(patch.secretScanInputs).toEqual([{ kind: "PATCH", text: "*** Begin Patch\n*** Add File: .env\n+API_KEY=secret\n*** End Patch" }]);
  });

  it("projects shell command facts without executing them", () => {
    const facts = projector("exec_command")({ cmd: "git status", workdir: "src", tty: true });
    expect(facts.shellCommand).toEqual({ command: "git status", workdir: "src", tty: true });
    expect(facts.secretScanInputs).toEqual([{ kind: "COMMAND", text: "git status" }]);
  });
});
