import {
  analyzeCommand,
  type CommandClassification,
  type CommandPlatform,
} from "./command-policy.js";

export type EffectConfidence = "EXACT" | "PARTIAL" | "OPAQUE";
export type EffectPathRelation = "WORKSPACE" | "OUTSIDE_WORKSPACE" | "PROTECTED_ROOT" | "UNKNOWN";
export type RecursiveDeleteResolution = "EXACT" | "BOUNDED_GLOB" | "DYNAMIC" | "UNKNOWN";

export interface EffectPathFact {
  readonly path: string;
  readonly relation: EffectPathRelation;
  readonly exact: boolean;
}

export interface EffectDeleteFact extends EffectPathFact {
  readonly recursive: boolean;
  readonly resolution: RecursiveDeleteResolution;
}

export interface CommandEffectAssessment {
  readonly confidence: EffectConfidence;
  readonly filesystem: {
    readonly reads: readonly EffectPathFact[];
    readonly writes: readonly EffectPathFact[];
    readonly deletes: readonly EffectDeleteFact[];
    readonly unknownTargets: boolean;
  };
  readonly process: {
    readonly spawnsChildren: boolean;
    readonly longRunning: boolean;
    readonly targetsManagedProcessIds: readonly string[];
    readonly targetsUnmanagedProcesses: boolean;
  };
  readonly network: {
    readonly mayAccessNetwork: boolean;
    readonly knownDestinations: readonly string[];
    readonly remoteMutation: boolean;
  };
  readonly privilege: {
    readonly requestsElevation: boolean;
    readonly modifiesIdentityOrPermissions: boolean;
  };
  readonly system: {
    readonly powerControl: boolean;
    readonly diskOrPartitionMutation: boolean;
    readonly serviceMutation: boolean;
    readonly securityPolicyMutation: boolean;
    readonly rawDeviceAccess: boolean;
  };
  readonly secrets: {
    readonly readsKnownSecretMaterial: boolean;
    readonly sendsDataToNetwork: boolean;
    readonly detectedTaintIds: readonly string[];
  };
  readonly execution: {
    readonly executablePath?: string;
    readonly interpreter?: string;
    readonly dynamicEvaluation: boolean;
    readonly opaqueBinary: boolean;
  };
  readonly classifications?: readonly CommandClassification[];
}

export interface AssessCommandEffectInput {
  readonly command: string;
  readonly platform: CommandPlatform;
  readonly workdir: string;
  readonly tty: boolean;
  /** Opaque IDs only; raw secret values must never enter this interface. */
  readonly secretTaintIds?: readonly string[];
}

export function assessCommandEffect(input: AssessCommandEffectInput): CommandEffectAssessment {
  const analysis = analyzeCommand(input);
  const classifications = analysis.classifications;
  const opaque = classifications.includes("OPAQUE_DYNAMIC");
  const tokens = tokenizeArguments(input.command);
  const executableToken = tokens[0] ?? "";
  const executable = executableName(executableToken);
  const taintIds = sanitizeTaintIds(input.secretTaintIds ?? []);
  const mayAccessNetwork =
    classifications.includes("NETWORK_ACCESS") || classifications.includes("REMOTE_MUTATION");
  const remoteMutation = classifications.includes("REMOTE_MUTATION");
  const deletes = assessDeletes(input, tokens, executable, classifications, opaque);
  const writes = assessWrites(input, tokens, executable, classifications, opaque);
  const reads = assessReads(tokens, executable, opaque);
  const protectedRoot = deletes.some((candidate) => candidate.relation === "PROTECTED_ROOT");
  const knownDestinations = findKnownDestinations(input.command);

  return Object.freeze({
    confidence: opaque ? "OPAQUE" : protectedRoot ? "PARTIAL" : "EXACT",
    filesystem: Object.freeze({
      reads: Object.freeze(reads),
      writes: Object.freeze(writes),
      deletes: Object.freeze(deletes),
      unknownTargets: opaque || deletes.some((candidate) => candidate.relation === "UNKNOWN"),
    }),
    process: Object.freeze({
      spawnsChildren: isLikelyProcessCommand(executable),
      longRunning: /(server|watch|daemon|serve|tail|sleep)/i.test(input.command),
      targetsManagedProcessIds: Object.freeze([]),
      targetsUnmanagedProcesses: isUnmanagedProcessTermination(executable, input.command),
    }),
    network: Object.freeze({
      mayAccessNetwork,
      knownDestinations: Object.freeze(knownDestinations),
      remoteMutation,
    }),
    privilege: Object.freeze({
      requestsElevation: classifications.includes("PRIVILEGE_ESCALATION"),
      modifiesIdentityOrPermissions: /\b(chown|chmod|icacls|set-acl|net\s+user|usermod)\b/i.test(
        input.command,
      ),
    }),
    system: Object.freeze({
      powerControl: isPowerControl(executable, input.command, classifications),
      diskOrPartitionMutation: isDiskOrPartitionMutation(
        executable,
        input.command,
        classifications,
      ),
      serviceMutation: isServiceMutation(executable, input.command, classifications),
      securityPolicyMutation: isSecurityPolicyMutation(executable, input.command, classifications),
      rawDeviceAccess: isRawDeviceAccess(executable, input.command, classifications),
    }),
    secrets: Object.freeze({
      readsKnownSecretMaterial: taintIds.length > 0,
      sendsDataToNetwork: taintIds.length > 0 && mayAccessNetwork,
      detectedTaintIds: Object.freeze(taintIds),
    }),
    execution: Object.freeze({
      ...(executableToken.length > 0 ? { executablePath: executableToken } : {}),
      ...(isInterpreter(executable) ? { interpreter: executable } : {}),
      dynamicEvaluation: opaque || /\b(eval|invoke-expression|iex)\b/i.test(input.command),
      opaqueBinary: false,
    }),
    classifications: Object.freeze([...classifications]),
  });
}

function assessDeletes(
  input: AssessCommandEffectInput,
  tokens: readonly string[],
  executable: string,
  classifications: readonly CommandClassification[],
  opaque: boolean,
): readonly EffectDeleteFact[] {
  const isDelete = ["rm", "remove-item", "del", "rmdir"].includes(executable);
  const classifiedDelete =
    classifications.includes("DESTRUCTIVE_LOCAL") || classifications.includes("SYSTEM_DESTRUCTIVE");
  if (
    !isDelete &&
    !(opaque && /\b(rm|remove-item|del|rmdir)\b/i.test(input.command)) &&
    !classifiedDelete
  )
    return [];
  const effectiveTokens =
    isDelete || opaque ? tokens : (findNestedDeleteTokens(input.command) ?? tokens);
  const effectiveExecutable = isDelete ? executable : executableName(effectiveTokens[0] ?? "");
  const recursive =
    effectiveExecutable === "rm"
      ? effectiveTokens.some((token) => /(^|-)r($|f|e)|recursive/i.test(token))
      : effectiveTokens.some((token) => /recursive|(^|[-/])s($|e)/i.test(token));
  const targets = effectiveTokens.filter((token, index) => index > 0 && !isOption(token));
  if (opaque || targets.length === 0) {
    return [
      {
        path: "[unknown target]",
        relation: "UNKNOWN",
        exact: false,
        recursive,
        resolution: opaque ? "DYNAMIC" : "UNKNOWN",
      },
    ];
  }
  return targets.map((target) => {
    const path = unquote(target);
    return {
      path,
      relation: classifyPathRelation(path, input.workdir),
      exact: !hasGlob(path),
      recursive,
      resolution: hasGlob(path) ? "BOUNDED_GLOB" : "EXACT",
    };
  });
}

function assessWrites(
  input: AssessCommandEffectInput,
  tokens: readonly string[],
  executable: string,
  classifications: readonly CommandClassification[],
  opaque: boolean,
): readonly EffectPathFact[] {
  if (opaque) return [];
  if (classifications.includes("LOCAL_REPO_MUTATION")) {
    return [{ path: ".", relation: "WORKSPACE", exact: true }];
  }
  if (
    [
      "touch",
      "mkdir",
      "install",
      "cp",
      "mv",
      "tee",
      "set-content",
      "out-file",
      "new-item",
    ].includes(executable)
  ) {
    const candidates = tokens.filter((token, index) => index > 0 && !isOption(token));
    const target = candidates.at(-1);
    if (target !== undefined) {
      const path = unquote(target);
      return [{ path, relation: classifyPathRelation(path, input.workdir), exact: !hasGlob(path) }];
    }
  }
  const redirection = /(?:^|\s)(?:>>|>)(?:\s*)([^\s;|&]+)/.exec(input.command);
  if (redirection?.[1] !== undefined) {
    const path = unquote(redirection[1]);
    return [{ path, relation: classifyPathRelation(path, input.workdir), exact: !hasGlob(path) }];
  }
  return [];
}

function assessReads(
  tokens: readonly string[],
  executable: string,
  opaque: boolean,
): readonly EffectPathFact[] {
  if (opaque) return [];
  if (
    ["cat", "head", "tail", "less", "more", "ls", "dir", "get-content", "type"].includes(executable)
  ) {
    const target = tokens.find((token, index) => index > 0 && !isOption(token));
    if (target !== undefined) {
      const path = unquote(target);
      return [{ path, relation: classifyPathRelation(path, "."), exact: !hasGlob(path) }];
    }
  }
  return [];
}

function classifyPathRelation(path: string, _workdir: string): EffectPathRelation {
  const normalized = path.replaceAll("\\", "/").trim();
  if (["/", "/*", "~", ".", "./", "C:", "C:/", "C:\\", "\\"].includes(normalized)) {
    return normalized === "." || normalized === "./" ? "WORKSPACE" : "PROTECTED_ROOT";
  }
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//")
  ) {
    return "OUTSIDE_WORKSPACE";
  }
  if (normalized.includes("$") || normalized.includes("%")) return "UNKNOWN";
  return "WORKSPACE";
}

function isOption(token: string): boolean {
  return token.startsWith("-") || /^\/[a-z]/i.test(token);
}

function hasGlob(value: string): boolean {
  return /[*?\[\]{}]/.test(value);
}

function tokenizeArguments(command: string): readonly string[] {
  const result: string[] = [];
  const matcher = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g;
  for (const match of command.matchAll(matcher)) {
    if (result.length >= 256) break;
    result.push(match[0]);
  }
  return result;
}

function unquote(value: string): string {
  return value.replace(/^['"]/, "").replace(/['"]$/, "");
}

function executableName(token: string): string {
  const normalized = unquote(token).replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function findKnownDestinations(command: string): readonly string[] {
  const destinations = new Set<string>();
  for (const match of command.matchAll(/\b(?:https?|ssh|git|ftp):\/\/([^\s/'";|&]+)/gi)) {
    const host = match[1]?.slice(0, 255);
    if (host !== undefined) destinations.add(host);
  }
  return [...destinations].sort();
}

function sanitizeTaintIds(values: readonly string[]): readonly string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) continue;
    result.add(value);
    if (result.size >= 32) break;
  }
  return [...result];
}

function isLikelyProcessCommand(executable: string): boolean {
  return ["node", "python", "python3", "java", "dotnet", "npm", "pnpm", "yarn", "cargo"].includes(
    executable,
  );
}

function isUnmanagedProcessTermination(executable: string, command: string): boolean {
  if (["taskkill", "stop-process", "spps", "pkill", "killall", "kill"].includes(executable)) {
    return true;
  }
  return /(?:^|[\s"';&|])(?:taskkill|stop-process|spps|pkill|killall|kill)(?:\.exe)?(?=[\s"';&|]|$)/i.test(
    command,
  );
}

function isPowerControl(
  executable: string,
  command: string,
  classifications: readonly CommandClassification[],
): boolean {
  return (
    ["shutdown", "reboot", "poweroff", "halt"].includes(executable) ||
    (classifications.includes("SYSTEM_DESTRUCTIVE") &&
      /(?:^|[\s"';&|])(?:shutdown|reboot|poweroff|halt)(?=[\s"';&|]|$)/i.test(command))
  );
}

function isDiskOrPartitionMutation(
  executable: string,
  command: string,
  classifications: readonly CommandClassification[],
): boolean {
  return (
    executable === "mkfs" ||
    (executable === "diskpart" && /\bclean\b/i.test(command)) ||
    (classifications.includes("SYSTEM_DESTRUCTIVE") && /(?:^|[\s"';&|])mkfs(?:\s|$)/i.test(command))
  );
}

function isServiceMutation(
  executable: string,
  command: string,
  _classifications: readonly CommandClassification[],
): boolean {
  return (
    ["systemctl", "service", "sc", "launchctl"].includes(executable) &&
    /\b(start|stop|restart|enable|disable|create|delete|config|load|unload)\b/i.test(command)
  );
}

function isSecurityPolicyMutation(
  executable: string,
  command: string,
  _classifications: readonly CommandClassification[],
): boolean {
  return (
    ["secedit", "auditpol", "setfacl", "icacls", "chmod", "chown"].includes(executable) ||
    /\b(set-executionpolicy|set-policy|netsh\s+advfirewall)\b/i.test(command)
  );
}

function isRawDeviceAccess(
  executable: string,
  command: string,
  classifications: readonly CommandClassification[],
): boolean {
  return (
    (executable === "dd" && /\bof=\s*\/dev\//i.test(command)) ||
    (classifications.includes("SYSTEM_DESTRUCTIVE") &&
      /(?:^|[\s"';&|])dd\b[^;&|]*\bof=\s*\/dev\//i.test(command))
  );
}

function findNestedDeleteTokens(command: string): readonly string[] | undefined {
  const match = /(?:^|[\s"';&|])(rm|remove-item|del|rmdir)(?:\s+[^;&|]*)?/i.exec(command);
  if (match === null || match[1] === undefined) return undefined;
  const leadingBoundary = match[0].search(/(?:rm|remove-item|del|rmdir)/i);
  return tokenizeArguments(command.slice(match.index + leadingBoundary));
}

function isInterpreter(executable: string): boolean {
  return ["sh", "bash", "zsh", "cmd", "powershell", "pwsh", "node", "python", "python3"].includes(
    executable,
  );
}
