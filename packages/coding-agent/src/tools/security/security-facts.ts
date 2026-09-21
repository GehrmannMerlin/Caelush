import type { JsonObject } from "@caelush/ai";
import { inspectPatchTargets } from "@caelush/runtime";

/**
 * The Coding security facts vocabulary.
 *
 * ```text
 * ToolResourceOperation    what a Tool does to a resource
 * ToolResourceAccess       one operation against one workspace-relative path
 * ToolShellCommandFact     the command, workdir and tty a Tool is about to run
 * ToolSecretScanInput      text a downstream secret scan must inspect
 * ToolSecurityFacts        the projected bundle the Security Gate consumes
 * ```
 *
 * ## Pure, host-only, never persisted
 *
 * A facts projector is a pure function from **prepared, schema-validated** arguments to host-side
 * analysis input. It runs after preparation and before admission, so it never sees raw provider
 * arguments, and it is the reason an input-aware Security decision can be made about the arguments the
 * Tool will *actually* receive.
 *
 * The facts may temporarily carry raw command text, a patch body or stdin — that is what a secret scan
 * needs — but they are never persisted, never emitted and never sent to the model. The Security Gate
 * consumes them and discards them.
 *
 * ## Failure is fail-closed
 *
 * A projector that throws raises `ToolSecurityFactsProjectionError`, and the admission layer treats
 * that as an untrusted-input boundary rather than as "no facts". If a projection failure could mean
 * "nothing to check", a malformed patch would be a way to skip input policy entirely.
 */

export type ToolResourceOperation = "READ" | "WRITE" | "DELETE" | "MOVE" | "SEARCH" | "DIFF";

export interface ToolResourceAccess {
  readonly operation: ToolResourceOperation;
  readonly path: string;
}

export interface ToolShellCommandFact {
  readonly command: string;
  readonly workdir: string;
  readonly tty: boolean;
}

export interface ToolSecretScanInput {
  readonly kind: "COMMAND" | "STDIN" | "PATCH" | "GENERIC";
  readonly text: string;
}

export interface ToolSecurityFacts {
  readonly resourceAccesses: readonly ToolResourceAccess[];
  readonly shellCommand?: ToolShellCommandFact;
  readonly secretScanInputs: readonly ToolSecretScanInput[];
  readonly structuralPreview?: JsonObject;
  readonly opaqueInput?: boolean;
}

/** A pure projection from prepared arguments to the facts a Security implementation analyzes. */
export type ToolSecurityFactsProjector = (args: Readonly<JsonObject>) => ToolSecurityFacts;

export class ToolSecurityFactsProjectionError extends Error {
  constructor(message = "Tool security facts could not be projected safely.") {
    super(message);
    this.name = "ToolSecurityFactsProjectionError";
  }
}

export function emptyToolSecurityFacts(): ToolSecurityFacts {
  return { resourceAccesses: [], secretScanInputs: [] };
}

export function assertToolSecurityFactsProjector(
  value: unknown,
): asserts value is ToolSecurityFactsProjector {
  if (typeof value !== "function") throw new TypeError("Tool security facts projector is invalid.");
}

/* ------------------------------------------------------------------------------------------------
 * Per-Tool projectors
 * ---------------------------------------------------------------------------------------------- */

function pathOf(value: unknown, field: string, fallback?: string): string {
  const path = value === undefined ? fallback : value;
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolSecurityFactsProjectionError(`The ${field} argument is not a path.`);
  }
  return path.replaceAll("\\", "/");
}

function resource(operation: ToolResourceOperation, path: string): ToolResourceAccess {
  return { operation, path };
}

export function projectReadFileSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = pathOf(args.path, "path");
  return {
    resourceAccesses: [resource("READ", path)],
    secretScanInputs: [],
    structuralPreview: { kind: "FILE_READ", path },
  };
}

export function projectListDirectorySecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = pathOf(args.path, "path");
  return {
    resourceAccesses: [],
    secretScanInputs: [],
    structuralPreview: { kind: "DIRECTORY_LIST", path },
  };
}

export function projectFindFilesSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = pathOf(args.path, "path", ".");
  if (typeof args.pattern !== "string" || args.pattern.length === 0) {
    throw new ToolSecurityFactsProjectionError("The pattern argument is invalid.");
  }
  return {
    resourceAccesses: [],
    secretScanInputs: [],
    structuralPreview: { kind: "FILE_DISCOVERY", path, pattern: args.pattern },
  };
}

export function projectSearchTextSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = pathOf(args.path, "path", ".");
  if (typeof args.pattern !== "string" || args.pattern.length === 0) {
    throw new ToolSecurityFactsProjectionError("The pattern argument is invalid.");
  }
  const include = args.include;
  if (include !== undefined && typeof include !== "string") {
    throw new ToolSecurityFactsProjectionError("The include argument is invalid.");
  }
  return {
    resourceAccesses: [resource("SEARCH", path)],
    secretScanInputs: [{ kind: "GENERIC", text: args.pattern }],
    structuralPreview: { kind: "TEXT_SEARCH", path, ...(include === undefined ? {} : { include }) },
  };
}

export function projectApplyPatchSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  if (typeof args.patch !== "string" || args.patch.length === 0) {
    throw new ToolSecurityFactsProjectionError("The patch argument is invalid.");
  }
  const targets = inspectPatchTargets(args.patch);
  return {
    resourceAccesses: targets.map((target) => ({ operation: target.operation, path: target.path })),
    secretScanInputs: [{ kind: "PATCH", text: args.patch }],
    structuralPreview: {
      kind: "PATCH",
      changes: targets.map((target) => ({
        operation: target.operation,
        path: target.path,
        ...(target.fromPath === undefined ? {} : { fromPath: target.fromPath }),
        ...(target.toPath === undefined ? {} : { toPath: target.toPath }),
      })),
    },
  };
}

export function projectExecCommandSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  if (typeof args.cmd !== "string" || args.cmd.length === 0) {
    throw new ToolSecurityFactsProjectionError("The cmd argument is invalid.");
  }
  const workdir = pathOf(args.workdir, "workdir", ".");
  if (args.tty !== undefined && typeof args.tty !== "boolean") {
    throw new ToolSecurityFactsProjectionError("The tty argument is invalid.");
  }
  return {
    resourceAccesses: [],
    shellCommand: { command: args.cmd, workdir, tty: args.tty === true },
    secretScanInputs: [{ kind: "COMMAND", text: args.cmd }],
    structuralPreview: {
      kind: "SHELL_COMMAND",
      command: args.cmd,
      workdir,
      tty: args.tty === true,
    },
  };
}

export function projectWriteStdinSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  if (typeof args.session_id !== "string" || args.session_id.length === 0) {
    throw new ToolSecurityFactsProjectionError("The session_id argument is invalid.");
  }
  const chars = args.chars ?? "";
  if (typeof chars !== "string") {
    throw new ToolSecurityFactsProjectionError("The chars argument is invalid.");
  }
  return {
    resourceAccesses: [],
    secretScanInputs: [{ kind: "STDIN", text: chars }],
    structuralPreview: {
      kind: "PROCESS_INPUT",
      sessionId: args.session_id,
      inputBytes: Buffer.byteLength(chars, "utf8"),
    },
  };
}

export function projectGitStatusSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = args.path === undefined ? "." : pathOf(args.path, "path");
  return {
    resourceAccesses: [],
    secretScanInputs: [],
    structuralPreview: { kind: "GIT_STATUS", path },
  };
}

export function projectGitDiffSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = args.path === undefined ? "." : pathOf(args.path, "path");
  return {
    resourceAccesses: [resource("DIFF", path)],
    secretScanInputs: [],
    structuralPreview: {
      kind: "GIT_DIFF",
      path,
      ...(args.scope === undefined ? {} : { scope: args.scope }),
    },
  };
}
