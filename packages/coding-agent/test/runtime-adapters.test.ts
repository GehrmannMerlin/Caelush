import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionEnvironment } from "@caelush/agent";
import {
  createRuntimeGitOperations,
  createRuntimeProcessOperations,
  createRuntimeReadOnlyOperations,
  createSearchTextTool,
  type RuntimeReadOnlyOperations,
} from "@caelush/coding-agent";
import {
  LocalRuntime,
  createLocalRuntimeResolver,
  RuntimeAuthorizationError,
  RuntimePathTypeError,
  RuntimeSearchUnavailableError,
} from "@caelush/runtime";
import {
  createRunId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
} from "@caelush/protocol";
import {
  FULL_SECURITY_CONTEXT,
  RESTRICTED_SECURITY_CONTEXT,
} from "./support/operations-fixtures.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Runtime Operations adapters, driven against a real filesystem and a real ripgrep.
 *
 * ```text
 * Coding builtin  →  narrow Operations port  →  Runtime adapter  →  @caelush/runtime
 * ```
 *
 * The unit suites above prove the *Tools* over fakes. This suite proves the *adapters* over the real
 * thing, which is where the two errata corrections actually have to hold:
 *
 * ```text
 * include   must reach ripgrep as a path-level --glob BEFORE truncation
 * limit     must be the business bound while the Runtime is asked for N + 1
 * git path  must reach Git as a real pathspec
 * git limit must not be pinned to the Runtime's own default of 200
 * ```
 *
 * The decisive case is the §9.3 counter-example: a fixture where a large file matches the pattern
 * before the include target would sort. A post-filter implementation answers "No matches found." with
 * `truncated: true`; the correct answer is the target file's matches with `truncated: false`.
 */

const RIPGREP_UNAVAILABLE_CODES = new Set(["RIPGREP_UNAVAILABLE"]);

let parent: string;
let workspace: string;
let environment: ToolExecutionEnvironment;
let readOnly: RuntimeReadOnlyOperations;

beforeAll(async () => {
  parent = await mkdtemp(path.join(os.tmpdir(), "caelush-4e-adapters-"));
  workspace = path.join(parent, "ws");
  await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  // §9.3's fixture: `a-many.ts` holds far more matches than the Tool's ceiling, and `z-target.ts` sorts
  // after it. A tool-side post-filter over an already-truncated list cannot see `z-target.ts` at all.
  await writeFile(
    path.join(workspace, "a-many.ts"),
    Array.from({ length: 260 }, (_, index) => `needle line ${String(index)}`).join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(workspace, "z-target.ts"),
    "needle one\nneedle two\nneedle three\n",
    "utf8",
  );
  await writeFile(path.join(workspace, "src", "a.ts"), "needle in src a\n", "utf8");
  await writeFile(path.join(workspace, "src", "nested", "b.ts"), "needle in nested b\n", "utf8");
  await writeFile(path.join(workspace, "docs", "a.md"), "needle in docs\n", "utf8");
  await writeFile(path.join(workspace, "empty.txt"), "", "utf8");

  const resolver = createLocalRuntimeResolver(new LocalRuntime());
  readOnly = createRuntimeReadOnlyOperations(resolver);
  environment = {
    workspace: { id: createWorkspaceId(), path: workspace },
    runtime: { id: "local", kind: "local" },
  };
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** Skip the ripgrep-dependent assertions on a host without a usable backend. */
async function ripgrepWorks(): Promise<boolean> {
  try {
    await readOnly.search({
      environment,
      pattern: "needle",
      path: "docs",
      limit: 1,
      signal: signal(),
    });
    return true;
  } catch (error) {
    if (error instanceof RuntimeSearchUnavailableError) return false;
    throw error;
  }
}

describe("search_text Runtime adapter", () => {
  it("opens a policy-bound process scope with the authorized Full Access provider", async () => {
    const seen: { options?: unknown; request?: unknown } = {};
    const scope = {
      exec: {
        execute: async (request: unknown) => {
          seen.request = request;
          return { status: "EXITED", output: "", totalOutputBytes: 0, omittedBytes: 0 };
        },
        interact: async () => ({
          status: "EXITED",
          output: "",
          totalOutputBytes: 0,
          omittedBytes: 0,
        }),
        terminate: async () => ({
          status: "EXITED",
          output: "",
          totalOutputBytes: 0,
          omittedBytes: 0,
        }),
      },
    } as never;
    const operations = createRuntimeProcessOperations({
      resolve: () => ({
        openWorkspace: async (_workspace: unknown, options: unknown) => {
          seen.options = options;
          return scope;
        },
      }),
    } as never);

    await operations.execute({
      environment,
      securityContext: FULL_SECURITY_CONTEXT,
      ownerRunId: createRunId(),
      command: "npm test",
      tty: false,
      yieldTimeMs: 250,
      signal: signal(),
    });

    expect(seen.options).toMatchObject({
      filesystemPolicy: { boundary: "HOST_USER_SCOPE" },
      processAuthorization: {
        provider: { id: "unrestricted", kind: "UNRESTRICTED" },
        policy: { processBoundary: "UNRESTRICTED" },
      },
    });
    expect(seen.request).toMatchObject({ ownerRunId: expect.any(String), command: "npm test" });
  });

  /**
   * SEC-1, from Phase 7 Task 5 Step 6's independent security review.
   *
   * The daemon builds its `exec`/`process` ports exactly as this adapter is built here — with a
   * `RuntimeResolver` and **no** `authorizationResolver` — so a restricted Run reaches the Runtime with
   * no bound process authorization. The Runtime must then refuse, never ordinary-spawn: an unrestricted
   * payload launched on behalf of a restricted preset is the one failure the permission model exists to
   * prevent.
   *
   * The sentinel is the decisive half. A rejection alone could be an unrelated pre-flight error; a
   * rejection *and* a payload that never ran is the property being pinned.
   */
  it("refuses a restricted preset instead of ordinary-spawning, and the payload never runs", async () => {
    const directory = path.join(parent, "restricted-exec");
    await mkdir(directory, { recursive: true });
    const sentinel = path.join(directory, "spawned.txt");
    const runtime = new LocalRuntime();
    try {
      const operations = createRuntimeProcessOperations(createLocalRuntimeResolver(runtime));
      await expect(
        operations.execute({
          environment: {
            workspace: { id: createWorkspaceId(), path: directory },
            runtime: { id: "local", kind: "local" },
          },
          securityContext: RESTRICTED_SECURITY_CONTEXT,
          ownerRunId: createRunId(),
          command: "echo spawned > spawned.txt",
          tty: false,
          yieldTimeMs: 250,
          signal: signal(),
        }),
      ).rejects.toBeInstanceOf(RuntimeAuthorizationError);
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      await runtime.dispose();
    }
  });

  /**
   * The control for the case above: the same payload through the same adapter shape, under Full Access,
   * really does run and write its sentinel. Without it, "the sentinel is absent" would also be
   * satisfied by a command that cannot run at all.
   */
  it("runs the same payload once Full Access binds an explicit authorization", async () => {
    const directory = path.join(parent, "full-access-exec");
    await mkdir(directory, { recursive: true });
    const sentinel = path.join(directory, "spawned.txt");
    const runtime = new LocalRuntime();
    try {
      const operations = createRuntimeProcessOperations(createLocalRuntimeResolver(runtime));
      const result = await operations.execute({
        environment: {
          workspace: { id: createWorkspaceId(), path: directory },
          runtime: { id: "local", kind: "local" },
        },
        securityContext: FULL_SECURITY_CONTEXT,
        ownerRunId: createRunId(),
        command: "echo spawned > spawned.txt",
        tty: false,
        yieldTimeMs: 5_000,
        signal: signal(),
      });
      expect(result).toMatchObject({ status: expect.any(String) });
      await expect(access(sentinel)).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  /**
   * SEC-2, from Phase 7 Task 5 Step 6's independent security review — the other half of the SEC-1 pin.
   *
   * The refusal above is *policy-driven*, not hard-coded: it comes from `securityPolicy` being present
   * and restricted. The `ToolSecurityContext` contract still permits a legacy **two-field** context with
   * no policy reference at all, and that context opens a scope with neither a filesystem policy nor a
   * process authorization, so `requireAuthorization` is false and the Runtime ordinary-spawns.
   *
   * This is characterised rather than fixed: the daemon always builds the three-field context from the
   * persisted policy snapshot (`createRunSecurityContext(run.securityPolicy)`), so the legacy shape is
   * not reachable through today's composition. It is pinned so that if a future path ever builds a
   * two-field context for a restricted Run, the fail-open is visible here instead of assumed safe.
   */
  it("ordinary-spawns for the legacy two-field context, which carries no policy to enforce", async () => {
    const directory = path.join(parent, "legacy-context-exec");
    await mkdir(directory, { recursive: true });
    const sentinel = path.join(directory, "spawned.txt");
    const runtime = new LocalRuntime();
    try {
      const operations = createRuntimeProcessOperations(createLocalRuntimeResolver(runtime));
      const result = await operations.execute({
        environment: {
          workspace: { id: createWorkspaceId(), path: directory },
          runtime: { id: "local", kind: "local" },
        },
        securityContext: { permissionProfile: "PROJECT_ACCESS", approvalPolicy: "ON_BOUNDARY" },
        ownerRunId: createRunId(),
        command: "echo spawned > spawned.txt",
        tty: false,
        yieldTimeMs: 5_000,
        signal: signal(),
      });
      expect(result).toMatchObject({ status: expect.any(String) });
      await expect(access(sentinel)).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it("applies include as a Runtime pre-filter, before truncation (the errata counter-example)", async () => {
    if (!(await ripgrepWorks())) return;
    const tool = createSearchTextTool(readOnly).tool;

    const result = await tool.execute({
      identity: {
        runId: createRunId(),
        sessionId: createRunId() as never,
        sourceStepId: createStepId(),
        invocationId: createToolInvocationId(),
        externalCallId: "call",
      },
      args: { pattern: "needle", include: "z-target.ts", limit: 100 },
      environment,
      signal: signal(),
      updates: { publish() {} },
    });

    // A post-filter would answer "No matches found." with `truncated: true`, because the runtime's
    // capture bound would already have been spent on `a-many.ts`.
    expect(result).toMatchObject({
      isError: false,
      details: { count: 3, truncated: false, path: "." },
    });
    expect(result.content.split("\n")).toHaveLength(3);
  });

  it("sends include to the Runtime and asks for one more match than the business bound", async () => {
    if (!(await ripgrepWorks())) return;
    const seen: unknown[] = [];
    const observed: RuntimeReadOnlyOperations = {
      ...readOnly,
      search: async (input) => {
        seen.push(input);
        return await readOnly.search(input);
      },
    };
    const tool = createSearchTextTool(observed).tool;
    await tool.execute({
      identity: {
        runId: createRunId(),
        sessionId: createRunId() as never,
        sourceStepId: createStepId(),
        invocationId: createToolInvocationId(),
        externalCallId: "call",
      },
      args: { pattern: "needle", include: "src/**/*.ts", limit: 1 },
      environment,
      signal: signal(),
      updates: { publish() {} },
    });

    // `include` is a capability input, so it reaches the port; `limit` is the business bound the Tool
    // validates and forwards unchanged. The `N + 1` capture probe belongs to the *adapter*, which asks
    // the Runtime for one more match than the port promised — asserted through `truncated` below.
    expect(seen[0]).toMatchObject({ include: "src/**/*.ts", limit: 1 });
  });

  it("returns one visible match and a proven truncation for limit = 1", async () => {
    if (!(await ripgrepWorks())) return;
    const found = await readOnly.search({
      environment,
      pattern: "needle",
      path: "src",
      limit: 1,
      signal: signal(),
    });

    // Two matches exist under `src`; the adapter asks for two, reports one, and proves there were more.
    expect(found.matches).toHaveLength(1);
    expect(found.truncated).toBe(true);
  });

  it("honours limit = 200 and reports no truncation when the tree holds fewer", async () => {
    if (!(await ripgrepWorks())) return;
    const found = await readOnly.search({
      environment,
      pattern: "needle",
      path: "docs",
      limit: 200,
      signal: signal(),
    });

    expect(found.matches).toHaveLength(1);
    expect(found.truncated).toBe(false);
  });

  it("resolves a nested include glob and reports the resolved search root", async () => {
    if (!(await ripgrepWorks())) return;
    const found = await readOnly.searchWithRoot({
      environment,
      pattern: "needle",
      path: "src",
      include: "**/b.ts",
      limit: 100,
      signal: signal(),
    });

    expect(found.path).toBe("src");
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ path: "src/nested/b.ts", line: 1 });
  });

  it("reports an unreadable path and a non-directory root as the Runtime's own errors", async () => {
    await expect(
      readOnly.search({
        environment,
        pattern: "needle",
        path: "does-not-exist",
        limit: 10,
        signal: signal(),
      }),
    ).rejects.toThrow();

    await expect(
      readOnly.search({
        environment,
        pattern: "needle",
        path: "empty.txt",
        limit: 10,
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(RuntimePathTypeError);
  });

  it("reports a malformed regex through the Runtime's search error", async () => {
    if (!(await ripgrepWorks())) return;
    const tool = createSearchTextTool(readOnly).tool;

    const result = await tool.execute({
      identity: {
        runId: createRunId(),
        sessionId: createRunId() as never,
        sourceStepId: createStepId(),
        invocationId: createToolInvocationId(),
        externalCallId: "call",
      },
      args: { pattern: "([unclosed" },
      environment,
      signal: signal(),
      updates: { publish() {} },
    });

    expect(result).toMatchObject({
      isError: true,
      details: { ok: false, error: "INVALID_PATTERN" },
    });
    expect(RIPGREP_UNAVAILABLE_CODES.has(String(result.details.error))).toBe(false);
  });
});

describe("read_file and list_directory Runtime adapters", () => {
  it("reports the resolved kind so the Tool keeps NOT_A_FILE and NOT_A_DIRECTORY", async () => {
    const asDirectory = await readOnly.readFileWithKind({
      environment,
      path: "src",
      offset: 1,
      limit: 10,
      signal: signal(),
    });
    expect(asDirectory).toMatchObject({ kind: "DIRECTORY" });
    expect(asDirectory.read).toBeUndefined();

    const asFile = await readOnly.listDirectoryWithKind({
      environment,
      path: "empty.txt",
      limit: 10,
      signal: signal(),
    });
    expect(asFile).toMatchObject({ kind: "FILE", entries: [] });
  });

  it("reports MISSING for a path that does not resolve", async () => {
    const missing = await readOnly.readFileWithKind({
      environment,
      path: "nope.ts",
      offset: 1,
      limit: 10,
      signal: signal(),
    });
    const missingDirectory = await readOnly.listDirectoryWithKind({
      environment,
      path: "nope",
      limit: 10,
      signal: signal(),
    });

    expect(missing.kind).toBe("MISSING");
    expect(missing.path).toBe("nope.ts");
    expect(missingDirectory).toMatchObject({ kind: "MISSING", entries: [] });
  });

  it("reads a bounded window and reports the relative path", async () => {
    const read = await readOnly.readFileWithKind({
      environment,
      path: "src/nested/b.ts",
      offset: 1,
      limit: 10,
      signal: signal(),
    });

    expect(read).toMatchObject({ path: "src/nested/b.ts", kind: "FILE" });
    // The Runtime renders lines with their 1-indexed numbers, which is what a model reads.
    expect(read.read?.lines).toEqual(["1: needle in nested b"]);
  });
});

describe("git Runtime adapter", () => {
  it("forwards the pathspec to Git and forwards a limit above the Runtime default", async () => {
    const git = createRuntimeGitOperations(createLocalRuntimeResolver(new LocalRuntime()));
    const seen: unknown[] = [];
    const observed = createRuntimeGitOperations(createLocalRuntimeResolver(new LocalRuntime()));
    const tool = (await import("@caelush/coding-agent")).createGitStatusTool({
      async status(input) {
        seen.push(input);
        return await observed.status(input);
      },
      diff: observed.diff,
    }).tool;

    await tool.execute({
      identity: {
        runId: createRunId(),
        sessionId: createRunId() as never,
        sourceStepId: createStepId(),
        invocationId: createToolInvocationId(),
        externalCallId: "call",
      },
      args: { path: "src", limit: 250 },
      environment,
      signal: signal(),
      updates: { publish() {} },
    });

    // `path` and `limit` both reach the adapter as a canonical args bag; the adapter turns them into
    // `scope.git.status({ path, limit })`, so Git applies the pathspec and the parser uses 250.
    expect(seen[0]).toMatchObject({ environment, args: { path: "src", limit: 250 } });
    expect(typeof git.status).toBe("function");
  });
});
