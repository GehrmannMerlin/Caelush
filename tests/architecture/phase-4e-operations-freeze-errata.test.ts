import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4E — the Operations Interface Freeze errata, asserted structurally.
 *
 * ```text
 * docs/architecture/v2/PHASE_4E_OPERATIONS_INTERFACE_FREEZE_ERRATA.md
 * ```
 *
 * The errata supersedes **only** Interface Freeze §165 (`SearchTextOperations`) and the `status` arm of
 * §169 (`GitOperations.status`). Every other frozen shape stays as it was. This guard is the executable
 * form of that scope statement: it fails if either corrected contract drifts, and it fails just as
 * loudly if one of the six contracts the errata promised not to touch acquires a field.
 *
 * The runtime behaviour the corrected contracts enable is proven elsewhere — the search pre-filter
 * counter-example and the Git path/limit regressions live in the Runtime adapter suites, which need a
 * real ripgrep and a real repository. What belongs here is the *shape*, because a shape is what the
 * freeze froze.
 */

const repositoryRoot = process.cwd();
const OPERATIONS_DIR = path.join(
  repositoryRoot,
  "packages",
  "coding-agent",
  "src",
  "tools",
  "operations",
);

async function read(relativePath: string): Promise<string> {
  return await readFile(path.join(OPERATIONS_DIR, relativePath), "utf8");
}

/** The source with comments removed, so a doc block cannot satisfy or break a shape assertion. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The members of one interface's method-input object literal. */
function methodInputMembers(
  text: string,
  interfaceName: string,
  methodName: string,
): readonly string[] {
  const clean = code(text);
  const start = clean.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`interface ${interfaceName} not found`);
  const methodStart = clean.indexOf(`${methodName}(input: {`, start);
  if (methodStart < 0) throw new Error(`method ${methodName} not found in ${interfaceName}`);
  const blockStart = clean.indexOf("{", methodStart) + 1;
  let depth = 0;
  let index = clean.indexOf("{", methodStart);
  for (; index < clean.length; index += 1) {
    if (clean[index] === "{") depth += 1;
    else if (clean[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const block = clean.slice(blockStart, index);
  const members: string[] = [];
  for (const match of block.matchAll(/^\s*readonly\s+([A-Za-z_][A-Za-z0-9_]*)(\??):/gm)) {
    members.push(`${match[1]}${match[2] ?? ""}`);
  }
  return members;
}

describe("Phase 4E errata — SearchTextOperations", () => {
  it("has exactly environment, pattern, path?, include?, limit, signal", async () => {
    const text = await read("search-text-operations.ts");

    expect(methodInputMembers(text, "SearchTextOperations", "search")).toEqual([
      "environment",
      "pattern",
      "path?",
      "include?",
      "limit",
      "signal",
    ]);
  });

  it("makes limit required, because it is a business bound rather than a convenience", async () => {
    const text = await read("search-text-operations.ts");

    // The old contract had no limit at all, and the adapter's `N + 1` capture probe is derived from it.
    // An optional limit would make "how many matches did the caller ask for" unanswerable.
    expect(methodInputMembers(text, "SearchTextOperations", "search")).toContain("limit");
    expect(methodInputMembers(text, "SearchTextOperations", "search")).not.toContain("limit?");
  });

  it("carries include as an optional input and not as a result field", async () => {
    const text = await read("search-text-operations.ts");

    expect(methodInputMembers(text, "SearchTextOperations", "search")).toContain("include?");
    // `include` is a capability input: it changes what ripgrep searches, so it may not be a filter the
    // Tool applies to an already-truncated result.
    expect(text).not.toMatch(/readonly include: string;/);
  });
});

describe("Phase 4E errata — GitOperations", () => {
  it("gives status and diff the same exact three inputs", async () => {
    const text = await read("git-operations.ts");

    expect(methodInputMembers(text, "GitOperations", "status")).toEqual([
      "environment",
      "args",
      "signal",
    ]);
    expect(methodInputMembers(text, "GitOperations", "diff")).toEqual([
      "environment",
      "args",
      "signal",
    ]);
  });

  it("keeps status a three-field shape rather than a widened one", async () => {
    const text = await code(await read("git-operations.ts"));

    // The errata names the fields the corrected contract may not carry. Each of them would turn the
    // narrow port into a capability handle.
    for (const forbidden of ["runtime", "scope", "gitService", "resolver", "absolutePath"]) {
      expect(text).not.toMatch(new RegExp(`readonly\\s+${forbidden}\\s*[?:]`));
    }
  });

  it("still declares exactly the two arms the freeze names", async () => {
    const text = await code(await read("git-operations.ts"));

    expect(text).toContain("status(input: {");
    expect(text).toContain("diff(input: {");
    // No third method, and no widened second signature for the same name.
    const methodNames = [...text.matchAll(/^\s{2}([a-zA-Z]+)\(input: \{/gm)].map((m) => m[1]);
    expect(methodNames).toEqual(["status", "diff"]);
  });
});

describe("Phase 4E errata — the six contracts it promised not to touch", () => {
  const unchanged: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "read-file-operations.ts",
      "ReadFileOperations",
      "read",
      ["environment", "path", "offset", "limit", "signal"],
    ],
    [
      "list-directory-operations.ts",
      "ListDirectoryOperations",
      "list",
      ["environment", "path", "limit", "signal"],
    ],
    [
      "find-files-operations.ts",
      "FindFilesOperations",
      "find",
      ["environment", "pattern", "path?", "limit", "signal"],
    ],
    ["patch-operations.ts", "PatchOperations", "apply", ["environment", "patch", "signal"]],
    [
      "exec-operations.ts",
      "ExecOperations",
      "execute",
      [
        "environment",
        "ownerRunId",
        "command",
        "workdir?",
        "tty",
        "yieldTimeMs",
        "signal",
        "onOutput?",
      ],
    ],
    [
      "process-operations.ts",
      "ProcessOperations",
      "interact",
      ["environment", "ownerRunId", "sessionId", "chars", "yieldTimeMs", "signal", "onOutput?"],
    ],
  ];

  for (const [fileName, interfaceName, methodName, expected] of unchanged) {
    it(`${interfaceName} still matches the original freeze`, async () => {
      const text = await read(fileName);
      expect(methodInputMembers(text, interfaceName, methodName)).toEqual(expected);
    });
  }
});

describe("Phase 4E errata — the invariants the correction did not move", () => {
  it("keeps ToolExecutionEnvironment at exactly { workspace, runtime }", async () => {
    const text = code(
      await readFile(
        path.join(
          repositoryRoot,
          "packages",
          "agent",
          "src",
          "tools",
          "types",
          "execution-environment.ts",
        ),
        "utf8",
      ),
    );

    expect(text).toMatch(
      /export interface ToolExecutionEnvironment \{\s*readonly workspace: WorkspaceRef;\s*readonly runtime: RuntimeRef;\s*\}/,
    );
  });

  it("keeps every Runtime capability out of every frozen Operations declaration", async () => {
    // Only the *frozen* contract files. `operations/runtime-adapters/` is the one directory in the
    // package permitted to hold a `RuntimeResolver`, and that is the point of the boundary: the
    // capability lives there and nowhere a Tool can reach it.
    const frozen = [
      "read-file-operations.ts",
      "list-directory-operations.ts",
      "find-files-operations.ts",
      "search-text-operations.ts",
      "patch-operations.ts",
      "exec-operations.ts",
      "process-operations.ts",
      "git-operations.ts",
      "operations.ts",
      "coding-read-only-operations.ts",
    ];

    for (const fileName of frozen) {
      const text = code(await readFile(path.join(OPERATIONS_DIR, fileName), "utf8"));
      for (const forbidden of [
        "RuntimeResolver",
        "RuntimeWorkspaceScope",
        "RuntimeFileSystem",
        "RuntimeGitService",
        "RuntimeExecService",
        "RuntimeTextSearchRequest",
        "LocalRuntime",
      ]) {
        expect(text, `${fileName} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the Runtime search and Git contracts untouched", async () => {
    // The errata's premise is that the defect was in the freeze, not in the Runtime: both Runtime
    // contracts already had what the corrected Operations needed.
    const searchRequest = await readFile(
      path.join(repositoryRoot, "packages", "runtime", "src", "search", "text-search.ts"),
      "utf8",
    );
    expect(code(searchRequest)).toMatch(/readonly limit: number;/);
    expect(code(searchRequest)).toMatch(/readonly include\?: string;/);

    const gitContracts = await readFile(
      path.join(repositoryRoot, "packages", "runtime", "src", "git", "contracts.ts"),
      "utf8",
    );
    expect(code(gitContracts)).toContain("status(input: {");
    expect(code(gitContracts)).toContain("path?: string");
    expect(code(gitContracts)).toContain("limit?: number");
  });

  it("keeps the canonical Tool pipeline and the frozen Tool turn out of the errata", async () => {
    // The correction is scoped to two Operations interfaces. Phase 4D's batch authorities and the
    // Phase 3 Tool turn contract are named in the errata's §3 as UNCHANGED, so their entry points are
    // asserted here rather than assumed.
    const turn = code(
      await readFile(
        path.join(repositoryRoot, "packages", "agent", "src", "run", "ports", "tool-turn.ts"),
        "utf8",
      ),
    );
    expect(turn).toContain("ToolTurnCoordinator");
    expect(turn).toContain("ToolTurnRequest");

    const batch = code(
      await readFile(
        path.join(
          repositoryRoot,
          "packages",
          "agent",
          "src",
          "tools",
          "batch",
          "batch-coordinator.ts",
        ),
        "utf8",
      ),
    );
    expect(batch).toContain("createToolBatchCoordinator");

    const feedback = code(
      await readFile(
        path.join(
          repositoryRoot,
          "packages",
          "agent",
          "src",
          "tools",
          "observation",
          "model-feedback-projector.ts",
        ),
        "utf8",
      ),
    );
    expect(feedback).toContain("createModelToolFeedbackProjector");
  });
});
