import { readFileSync } from "node:fs";
import path from "node:path";
import { OPERATIONS_INTERFACE_NAMES } from "@caelush/coding-agent";
import { describe, expect, it } from "vitest";

/**
 * The exact Operations contracts, asserted against the declarations in source.
 *
 * ```text
 * a structural type test proves a Tool COMPILES against a shape
 * this suite proves the shape is EXACTLY the frozen one
 * ```
 *
 * Phase 4E needed both, because the errata corrected two of the eight contracts against production
 * source. The corrected shapes must now be pinned field for field — including the six that were *not*
 * changed, and including the fact that none of them gained anything else.
 *
 * A TypeScript interface is erased at runtime, so "this interface has exactly these members and no
 * others" can only be asserted by reading the declaration. The reads are deliberately narrow — one
 * file per contract — and everything else in this suite is behavioural or structural.
 */

const OPERATIONS_DIR = path.join(
  process.cwd(),
  "packages",
  "coding-agent",
  "src",
  "tools",
  "operations",
);

function declaration(fileName: string): string {
  return readFileSync(path.join(OPERATIONS_DIR, fileName), "utf8");
}

/**
 * The source with block and line comments removed.
 *
 * The declarations carry long doc comments that quote the shapes they describe and explain why the
 * Runtime boundary exists, so a naive read would find `readonly args:` inside a example block and
 * `RuntimeResolver` inside a rationale. Only the code answers the question this suite asks.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The body of one named interface, comments removed. */
function interfaceBody(source: string, interfaceName: string): string {
  const clean = withoutComments(source);
  const start = clean.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`interface ${interfaceName} not found`);
  let depth = 0;
  let index = clean.indexOf("{", start);
  const bodyStart = index + 1;
  for (; index < clean.length; index += 1) {
    if (clean[index] === "{") depth += 1;
    else if (clean[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return clean.slice(bodyStart, index);
}

/** The `readonly <name>` members declared directly in one interface body. */
function membersOf(source: string, interfaceName: string): readonly string[] {
  const members: string[] = [];
  const pattern = /^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)(\??):/gm;
  for (const match of interfaceBody(source, interfaceName).matchAll(pattern)) {
    members.push(`${match[1]}${match[2] ?? ""}`);
  }
  return members;
}

/**
 * The `readonly <name>` members of the **input** object literal of one method.
 *
 * ```text
 * someMethod(input: {            ← the input block, from this brace
 *   readonly a: string;
 * }): Promise<{                  ← to this brace
 *   readonly b: string;          ← the result block, deliberately not read
 * }>;
 * ```
 *
 * The split matters: the frozen input shape is what a Tool passes and what the errata corrected, while
 * the result shape is a separate projection a Tool reports. Reading them together would make a change
 * to either one look like a change to the contract.
 */
function methodInputMembers(
  source: string,
  interfaceName: string,
  methodName: string,
): readonly string[] {
  const body = interfaceBody(source, interfaceName);
  const methodStart = body.indexOf(`${methodName}(input: {`);
  if (methodStart < 0) throw new Error(`method ${methodName} not found in ${interfaceName}`);
  const blockStart = body.indexOf("{", methodStart) + 1;
  let depth = 0;
  let index = body.indexOf("{", methodStart);
  for (; index < body.length; index += 1) {
    if (body[index] === "{") depth += 1;
    else if (body[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const block = body.slice(blockStart, index);
  const members: string[] = [];
  const pattern = /^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)(\??):/gm;
  for (const match of block.matchAll(pattern)) members.push(`${match[1]}${match[2] ?? ""}`);
  return members;
}

const UNCHANGED_FILES = [
  "read-file-operations.ts",
  "list-directory-operations.ts",
  "find-files-operations.ts",
  "patch-operations.ts",
  "exec-operations.ts",
  "process-operations.ts",
  "git-operations.ts",
];

describe("Operations exact contracts — the six unchanged contracts", () => {
  it("ReadFileOperations is exactly environment, path, offset, limit, signal", () => {
    expect(
      methodInputMembers(declaration("read-file-operations.ts"), "ReadFileOperations", "read"),
    ).toEqual(["environment", "path", "offset", "limit", "signal"]);
  });

  it("ListDirectoryOperations is exactly environment, path, limit, signal", () => {
    expect(
      methodInputMembers(
        declaration("list-directory-operations.ts"),
        "ListDirectoryOperations",
        "list",
      ),
    ).toEqual(["environment", "path", "limit", "signal"]);
  });

  it("FindFilesOperations is exactly environment, pattern, path?, limit, signal", () => {
    expect(
      methodInputMembers(declaration("find-files-operations.ts"), "FindFilesOperations", "find"),
    ).toEqual(["environment", "pattern", "path?", "limit", "signal"]);
  });

  it("PatchOperations is exactly environment, patch, signal", () => {
    expect(
      methodInputMembers(declaration("patch-operations.ts"), "PatchOperations", "apply"),
    ).toEqual(["environment", "patch", "signal"]);
  });

  it("ExecOperations is exactly environment, ownerRunId, command, workdir?, tty, yieldTimeMs, signal, onOutput?", () => {
    expect(
      methodInputMembers(declaration("exec-operations.ts"), "ExecOperations", "execute"),
    ).toEqual([
      "environment",
      "ownerRunId",
      "command",
      "workdir?",
      "tty",
      "yieldTimeMs",
      "signal",
      "onOutput?",
    ]);
  });

  it("ProcessOperations is exactly environment, ownerRunId, sessionId, chars, yieldTimeMs, signal, onOutput?", () => {
    expect(
      methodInputMembers(declaration("process-operations.ts"), "ProcessOperations", "interact"),
    ).toEqual([
      "environment",
      "ownerRunId",
      "sessionId",
      "chars",
      "yieldTimeMs",
      "signal",
      "onOutput?",
    ]);
  });
});

describe("Operations exact contracts — the two errata-corrected contracts", () => {
  it("SearchTextOperations is exactly environment, pattern, path?, include?, limit, signal", () => {
    // The corrected contract. `include` and `limit` are operation semantics — `include` is a ripgrep
    // `--glob` applied BEFORE truncation and `limit` determines the capture strategy — which is why the
    // errata superseded the original shape rather than letting a Tool post-filter.
    expect(
      methodInputMembers(
        declaration("search-text-operations.ts"),
        "SearchTextOperations",
        "search",
      ),
    ).toEqual(["environment", "pattern", "path?", "include?", "limit", "signal"]);
    expect(declaration("search-text-operations.ts")).toContain(
      "PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md",
    );
  });

  it("GitOperations.status and .diff are both exactly environment, args, signal", () => {
    const source = declaration("git-operations.ts");
    // `status` gained `args`, symmetric with the `diff` arm that already carried one. Both arms carry
    // the same three input members, read separately so neither can drift from the other unnoticed.
    const status = methodInputMembers(source, "GitOperations", "status");
    const diff = methodInputMembers(source, "GitOperations", "diff");
    expect(status).toEqual(["environment", "args", "signal"]);
    expect(diff).toEqual(["environment", "args", "signal"]);
    expect(status).toEqual(diff);
  });
});

describe("Operations exact contracts — the shared boundary rules", () => {
  it("declares exactly the eight frozen interface names, once each", () => {
    expect(OPERATIONS_INTERFACE_NAMES).toEqual([
      "ReadFileOperations",
      "ListDirectoryOperations",
      "FindFilesOperations",
      "SearchTextOperations",
      "PatchOperations",
      "ExecOperations",
      "ProcessOperations",
      "GitOperations",
    ]);
  });

  it("gives every operation an environment and a required signal", () => {
    for (const fileName of [...UNCHANGED_FILES, "search-text-operations.ts", "git-operations.ts"]) {
      const source = declaration(fileName);
      // Required, never optional: cancellation must exist on every hop from Run cancellation to the
      // Runtime operation, so an Operation may not have an `undefined` story of its own.
      expect(source).toContain("readonly environment: ToolExecutionEnvironment;");
      expect(source).toContain("readonly signal: AbortSignal;");
      expect(source).not.toContain("readonly signal?:");
      expect(source).not.toContain("readonly environment?:");
    }
  });

  it("names no Runtime capability in any Operation public input", () => {
    // The *declarations* are read with comments stripped, because an Operation port's doc block exists
    // to explain which capability it deliberately does not carry and naming it there is the point.
    // What must never appear is the capability in a member the compiler would accept.
    for (const fileName of [...UNCHANGED_FILES, "search-text-operations.ts"]) {
      const source = withoutComments(declaration(fileName));
      for (const forbidden of [
        "RuntimeResolver",
        "RuntimeWorkspaceScope",
        "RuntimeFileSystem",
        "RuntimeGitService",
        "RuntimeExecService",
        "LocalRuntime",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("keeps ToolExecutionEnvironment at exactly { workspace, runtime }", () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "packages",
        "agent",
        "src",
        "tools",
        "types",
        "execution-environment.ts",
      ),
      "utf8",
    );
    expect(membersOf(source, "ToolExecutionEnvironment")).toEqual(["workspace", "runtime"]);
  });
});
