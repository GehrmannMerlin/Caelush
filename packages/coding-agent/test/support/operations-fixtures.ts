import type { AgentToolExecutionInput, ToolExecutionEnvironment } from "@caelush/agent";
import type {
  ExecOperations,
  GitOperations,
  PatchOperations,
  ProcessOperations,
  ReadFileOperations,
  RuntimeReadOnlyOperations,
} from "@caelush/coding-agent";
import { RuntimePathTypeError } from "@caelush/runtime";
import {
  createRunId,
  createStepId,
  createToolInvocationId,
  createWorkspaceId,
  type JsonObject,
} from "@caelush/protocol";

/**
 * The Phase 4E Operations fixtures.
 *
 * ```text
 * a fake port per capability family    so a builtin unit test needs no filesystem, shell or Git repo
 * a canonical execution input builder  so every target Tool is driven the way the registry drives it
 * ```
 *
 * `ToolExecutionEnvironment` is exactly `{ workspace, runtime }`, and every Operation receives it plus a
 * required `AbortSignal`. A fake therefore has no ambient authority to fake away: there is no runtime
 * to resolve and no scope to open, which is what the narrow ports were introduced for.
 */

export const WORKSPACE = Object.freeze({
  id: createWorkspaceId(),
  path: "/workspace",
});

export const ENVIRONMENT: ToolExecutionEnvironment = Object.freeze({
  workspace: WORKSPACE,
  runtime: Object.freeze({ id: "local", kind: "local" }),
});

/** A signal a test controls, so cancellation forwarding is observable rather than assumed. */
export function testSignal(): AbortSignal {
  return new AbortController().signal;
}

/** A JSON argument bag, as the canonical Preparer would have produced it. */
export function args(value: Record<string, unknown>): JsonObject {
  return value as JsonObject;
}

/**
 * The canonical execution input.
 *
 * A target Tool is an `AgentTool`, so the shape it receives is the canonical one — identity, prepared
 * args, environment, a required signal and the update sink. Building it here means a builtin test
 * exercises the real execute signature rather than a legacy adaptation of it.
 */
export function executionInput(
  value: Record<string, unknown>,
  overrides: {
    readonly signal?: AbortSignal;
    readonly environment?: ToolExecutionEnvironment;
    readonly publish?: (update: unknown) => void;
    readonly runId?: string;
  } = {},
): AgentToolExecutionInput {
  return {
    identity: {
      runId: (overrides.runId ?? createRunId()) as never,
      sessionId: createRunId() as never,
      sourceStepId: createStepId(),
      invocationId: createToolInvocationId(),
      externalCallId: "call-1",
    },
    args: args(value),
    environment: overrides.environment ?? ENVIRONMENT,
    signal: overrides.signal ?? testSignal(),
    updates: { publish: (update) => overrides.publish?.(update) },
  };
}

/**
 * A complete fake read-only family.
 *
 * The four read-only ports are separate interfaces but one Runtime adapter implements them together,
 * so a fake that satisfies `RuntimeReadOnlyOperations` can stand in for any of the four Tools. Every
 * method records its input, which is how a test asserts *what reached the port* — the evidence that
 * `include` and `limit` reach the Runtime rather than being applied tool-side.
 */
export interface ReadOnlyFakeCalls {
  readonly read: unknown[];
  readonly list: unknown[];
  readonly listWithProbe: unknown[];
  readonly listDirectoryWithKind: unknown[];
  readonly find: unknown[];
  readonly findWithRoot: unknown[];
  readonly search: unknown[];
  readonly searchWithRoot: unknown[];
}

export interface ReadOnlyFake {
  readonly operations: RuntimeReadOnlyOperations;
  readonly calls: ReadOnlyFakeCalls;
}

/** What a `readFileWithKind` answer looks like, so a test can build one without naming the port. */
export type ReadFileWithKindAnswer = Awaited<
  ReturnType<RuntimeReadOnlyOperations["readFileWithKind"]>
>;

/** What a `listDirectoryWithKind` answer looks like. */
export type ListDirectoryWithKindAnswer = Awaited<
  ReturnType<RuntimeReadOnlyOperations["listDirectoryWithKind"]>
>;

/** A `readFileWithKind` answer for a successful read, with the fields a test does not care about fixed. */
export function readFileAnswer(
  overrides: {
    readonly path?: string;
    readonly lines?: readonly string[];
    readonly truncated?: boolean;
    readonly nextOffset?: number;
    readonly bytesReturned?: number;
    readonly utf8Bom?: boolean;
  } = {},
): ReadFileWithKindAnswer {
  return {
    path: overrides.path ?? "src/a.ts",
    kind: "FILE",
    read: {
      lines: overrides.lines ?? ["line one"],
      truncated: overrides.truncated ?? false,
      ...(overrides.nextOffset === undefined ? {} : { nextOffset: overrides.nextOffset }),
      bytesReturned: overrides.bytesReturned ?? 8,
      utf8Bom: overrides.utf8Bom ?? false,
    },
  };
}

/** A `readFileWithKind` answer for a path that resolved to something other than a readable file. */
export function readFileKindAnswer(
  kind: "DIRECTORY" | "SYMLINK" | "OTHER" | "MISSING",
  path = "src",
): ReadFileWithKindAnswer {
  return { path, kind };
}

/** A `listDirectoryWithKind` answer. */
export function listDirectoryAnswer(overrides: {
  readonly path?: string;
  readonly kind?: "DIRECTORY" | "FILE" | "SYMLINK" | "OTHER" | "MISSING";
  readonly entries?: readonly JsonObject[];
}): ListDirectoryWithKindAnswer {
  return {
    path: overrides.path ?? ".",
    kind: overrides.kind ?? "DIRECTORY",
    entries: overrides.entries ?? [],
  };
}

/** One directory entry, in the shape the Runtime adapter reports. */
export function entry(name: string, kind: "FILE" | "DIRECTORY" | "SYMLINK" = "FILE"): JsonObject {
  return { name, path: name, kind };
}

/**
 * Pick the answer for one probe.
 *
 * ```text
 * a probe the test supplied        use it
 * a probe the test did not supply  fall back to the frozen port's answer
 * ```
 *
 * The presence check is `Object.hasOwn`, not `??`: `exactOptionalPropertyTypes` treats "absent" and
 * "explicitly undefined" as different, and a test that passes `find` alone means "the probe falls back
 * to `find`", while a test that passes `findWithRoot` means "use it".
 */
function answerFor<T>(supplied: T | undefined, fallback: T | undefined): T {
  return (supplied === undefined ? fallback : supplied)!;
}
/**
 * Build a fake read-only family whose answers each test supplies.
 *
 * The parameter is a record of optional answers rather than an inline object type, because a caller
 * passing a *single* answer whose own type contains optional members hits
 * `exactOptionalPropertyTypes`: the compiler cannot tell "this key is absent" from "this key holds a
 * value that may itself be `undefined`". The explicit shape keeps the call sites readable.
 */
export interface ReadOnlyFakeAnswers {
  /**
   * The read answer.
   *
   * The frozen `ReadFileOperations.read` and the `readFileWithKind` probe are one resolution with two
   * projections, so a single answer drives both: supplying the kind-reporting form is enough, and the
   * plain `read` is derived from it. That is also what keeps a test from accidentally asserting one
   * projection while the Tool uses the other.
   */
  readonly read?:
    ReadFileOperations["read"] | RuntimeReadOnlyOperations["readFileWithKind"] | undefined;
  readonly list?: RuntimeReadOnlyOperations["list"] | undefined;
  readonly listWithProbe?: RuntimeReadOnlyOperations["listWithProbe"] | undefined;
  readonly listDirectoryWithKind?: RuntimeReadOnlyOperations["listDirectoryWithKind"] | undefined;
  readonly find?: RuntimeReadOnlyOperations["find"] | undefined;
  readonly findWithRoot?: RuntimeReadOnlyOperations["findWithRoot"] | undefined;
  readonly search?: RuntimeReadOnlyOperations["search"] | undefined;
  readonly searchWithRoot?: RuntimeReadOnlyOperations["searchWithRoot"] | undefined;
}

export function readOnlyFake(answers: ReadOnlyFakeAnswers): ReadOnlyFake {
  const calls: {
    read: unknown[];
    list: unknown[];
    listWithProbe: unknown[];
    listDirectoryWithKind: unknown[];
    find: unknown[];
    findWithRoot: unknown[];
    search: unknown[];
    searchWithRoot: unknown[];
  } = {
    read: [],
    list: [],
    listWithProbe: [],
    listDirectoryWithKind: [],
    find: [],
    findWithRoot: [],
    search: [],
    searchWithRoot: [],
  };
  const kindAnswer = answers.read as RuntimeReadOnlyOperations["readFileWithKind"] | undefined;
  const plainAnswer = answers.read as ReadFileOperations["read"] | undefined;
  const operations: RuntimeReadOnlyOperations = {
    async read(input) {
      calls.read.push(input);
      if (kindAnswer === undefined) return await plainAnswer!(input);
      const answer = await kindAnswer(input);
      if (answer.read === undefined) throw new RuntimePathTypeError("path is not a readable file");
      return { path: answer.path, ...answer.read };
    },
    async readFileWithKind(input) {
      calls.read.push(input);
      if (kindAnswer === undefined) {
        const answer = await plainAnswer!(input);
        return {
          path: answer.path,
          kind: "FILE",
          read: {
            lines: answer.lines,
            truncated: answer.truncated,
            ...(answer.nextOffset === undefined ? {} : { nextOffset: answer.nextOffset }),
            bytesReturned: answer.bytesReturned,
            utf8Bom: answer.utf8Bom,
          },
        };
      }
      return await kindAnswer(input);
    },
    async list(input) {
      calls.list.push(input);
      return await answers.list!(input);
    },
    async listWithProbe(input) {
      calls.listWithProbe.push(input);
      return await answers.listWithProbe!(input);
    },
    listDirectoryWithKind: async (
      input: Parameters<RuntimeReadOnlyOperations["listDirectoryWithKind"]>[0],
    ) => {
      calls.listDirectoryWithKind.push(input);
      return await (answers.listDirectoryWithKind ?? (async () => listDirectoryAnswer({})))!(input);
    },
    async find(input) {
      calls.find.push(input);
      return await answers.find!(input);
    },
    findWithRoot: (async (input: unknown) => {
      calls.findWithRoot.push(input);
      return await answerFor(answers.findWithRoot, answers.find)!(input as never);
    }) as never,
    async search(input) {
      calls.search.push(input);
      return await answers.search!(input);
    },
    searchWithRoot: (async (input: unknown) => {
      calls.searchWithRoot.push(input);
      return await answerFor(answers.searchWithRoot, answers.search)!(input as never);
    }) as never,
  };
  return { operations, calls: calls as ReadOnlyFakeCalls };
}

/** A fake patch port. */
export function patchFake(apply: PatchOperations["apply"]): {
  readonly operations: PatchOperations;
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    operations: {
      async apply(input) {
        calls.push(input);
        return await apply(input);
      },
    },
    calls,
  };
}

/** A fake process family: `exec_command` and `write_stdin` are two ports over one Runtime service. */
export function processFake(answers: {
  execute: ExecOperations["execute"];
  interact: ProcessOperations["interact"];
}): {
  readonly exec: ExecOperations;
  readonly process: ProcessOperations;
  readonly calls: { readonly execute: unknown[]; readonly interact: unknown[] };
} {
  const calls = { execute: [] as unknown[], interact: [] as unknown[] };
  return {
    exec: {
      async execute(input) {
        calls.execute.push(input);
        return await answers.execute(input);
      },
    },
    process: {
      async interact(input) {
        calls.interact.push(input);
        return await answers.interact(input);
      },
    },
    calls,
  };
}

/** A fake Git port. */
export function gitFake(answers: {
  status: GitOperations["status"];
  diff?: GitOperations["diff"];
}): {
  readonly operations: GitOperations;
  readonly calls: { readonly status: unknown[]; readonly diff: unknown[] };
} {
  const calls = { status: [] as unknown[], diff: [] as unknown[] };
  return {
    operations: {
      async status(input) {
        calls.status.push(input);
        return await answers.status(input);
      },
      async diff(input) {
        calls.diff.push(input);
        return await (answers.diff ?? (async () => ({})))(input);
      },
    },
    calls,
  };
}

/** A spy that always fails when called, for asserting an Operation was never reached. */
export function neverCalled(name: string): () => never {
  return () => {
    throw new Error(`${name} must not be called`);
  };
}
