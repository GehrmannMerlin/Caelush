import { inspectPatchTargets } from "@caelush/runtime";
import type { JsonObject } from "@caelush/protocol";
import {
  ToolSecurityFactsProjectionError,
  type ToolResourceAccess,
  type ToolSecurityFacts,
} from "../security-facts.js";

function pathOf(value: unknown, field: string, fallback?: string): string {
  const path = value === undefined ? fallback : value;
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolSecurityFactsProjectionError(`The ${field} argument is not a path.`);
  }
  return path.replaceAll("\\", "/");
}

function resource(operation: ToolResourceAccess["operation"], path: string): ToolResourceAccess {
  return { operation, path };
}

export function projectReadFileSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = pathOf(args.path, "path");
  return { resourceAccesses: [resource("READ", path)], secretScanInputs: [] };
}

export function projectListDirectorySecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = pathOf(args.path, "path");
  return { resourceAccesses: [], secretScanInputs: [], structuralPreview: { kind: "DIRECTORY_LIST", path } };
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
    structuralPreview: { kind: "SHELL_COMMAND", command: args.cmd, workdir, tty: args.tty === true },
  };
}

export function projectWriteStdinSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  if (typeof args.session_id !== "string" || args.session_id.length === 0) {
    throw new ToolSecurityFactsProjectionError("The session_id argument is invalid.");
  }
  const chars = args.chars ?? "";
  if (typeof chars !== "string") throw new ToolSecurityFactsProjectionError("The chars argument is invalid.");
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
  return { resourceAccesses: [], secretScanInputs: [], structuralPreview: { kind: "GIT_STATUS", path } };
}

export function projectGitDiffSecurityFacts(args: Readonly<JsonObject>): ToolSecurityFacts {
  const path = args.path === undefined ? "." : pathOf(args.path, "path");
  return {
    resourceAccesses: [resource("DIFF", path)],
    secretScanInputs: [],
    structuralPreview: { kind: "GIT_DIFF", path, ...(args.scope === undefined ? {} : { scope: args.scope }) },
  };
}
