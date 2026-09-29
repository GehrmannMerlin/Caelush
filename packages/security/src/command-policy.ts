export type CommandPlatform = "POSIX_SH" | "POWERSHELL" | "CMD";

export type CommandClassification =
  | "NORMAL_LOCAL"
  | "LOCAL_REPO_MUTATION"
  | "DESTRUCTIVE_LOCAL"
  | "NETWORK_ACCESS"
  | "REMOTE_MUTATION"
  | "PRIVILEGE_ESCALATION"
  | "SYSTEM_DESTRUCTIVE"
  | "OPAQUE_DYNAMIC";

export const MAX_COMMAND_WRAPPER_DEPTH = 8;
export const MAX_COMMAND_PREVIEW_BYTES = 2048;

export interface CommandPolicyInput {
  readonly command: string;
  readonly platform: CommandPlatform;
  readonly workdir: string;
  readonly tty: boolean;
}

export interface CommandPolicyAnalysis {
  readonly classifications: readonly CommandClassification[];
  readonly wrapperDepth: number;
  readonly preview: string;
}

interface TokenizedCommand {
  readonly segments: readonly (readonly string[])[];
  readonly opaque: boolean;
}

export function analyzeCommand(input: CommandPolicyInput): CommandPolicyAnalysis {
  if (
    typeof input.command !== "string" ||
    typeof input.workdir !== "string" ||
    typeof input.tty !== "boolean" ||
    !["POSIX_SH", "POWERSHELL", "CMD"].includes(input.platform)
  ) {
    return { classifications: ["OPAQUE_DYNAMIC"], wrapperDepth: 0, preview: "[opaque command]" };
  }
  const result = analyzeText(input.command, input.platform, 0);
  return {
    classifications: orderClassifications(result.classifications),
    wrapperDepth: result.wrapperDepth,
    preview: boundedPreview(input.command),
  };
}

function analyzeText(
  command: string,
  platform: CommandPlatform,
  depth: number,
): {
  readonly classifications: ReadonlySet<CommandClassification>;
  readonly wrapperDepth: number;
} {
  const tokenized = tokenize(command, platform);
  if (tokenized.opaque || tokenized.segments.length === 0) {
    return { classifications: new Set(["OPAQUE_DYNAMIC"]), wrapperDepth: depth };
  }
  const classifications = new Set<CommandClassification>();
  let wrapperDepth = depth;
  for (const segment of tokenized.segments) {
    if (segment.length === 0) continue;
    const result = analyzeSegment(segment, platform, depth);
    for (const classification of result.classifications) classifications.add(classification);
    wrapperDepth = Math.max(wrapperDepth, result.wrapperDepth);
  }
  if (classifications.size === 0) classifications.add("NORMAL_LOCAL");
  return { classifications, wrapperDepth };
}

function analyzeSegment(
  tokens: readonly string[],
  platform: CommandPlatform,
  depth: number,
): { readonly classifications: ReadonlySet<CommandClassification>; readonly wrapperDepth: number } {
  const classifications = new Set<CommandClassification>();
  if (containsDynamicSyntax(tokens, platform)) {
    classifications.add("OPAQUE_DYNAMIC");
    return { classifications, wrapperDepth: depth };
  }
  const executable = basename(tokens[0] ?? "");
  if (isShellWrapper(executable, tokens)) {
    // The body grammar follows the *wrapper* shell, not the host shell, and the body flag set is
    // read from that same grammar — `powershell -Command "..."` hosted by a POSIX shell is a
    // PowerShell body, so its `-Command` flag is a flag and not an unmatchable POSIX `-c`.
    const nestedPlatform = wrapperPlatform(executable, platform);
    const body = wrapperBody(tokens, nestedPlatform);
    const nextDepth = depth + 1;
    if (nextDepth > MAX_COMMAND_WRAPPER_DEPTH || body === undefined) {
      classifications.add("OPAQUE_DYNAMIC");
      return { classifications, wrapperDepth: nextDepth };
    }
    const nested = analyzeText(body, nestedPlatform, nextDepth);
    for (const classification of nested.classifications) classifications.add(classification);
    return { classifications, wrapperDepth: nested.wrapperDepth };
  }

  const command = executableName(tokens[0] ?? "");
  if (command === "env") {
    const nested = analyzeText(tokens.slice(skipEnvPrefix(tokens)).join(" "), platform, depth);
    for (const classification of nested.classifications) classifications.add(classification);
  }
  if (command === "sudo" || command === "su" || command === "doas" || command === "runas") {
    classifications.add("PRIVILEGE_ESCALATION");
    const nested = analyzeText(tokens.slice(1).join(" "), platform, depth);
    for (const classification of nested.classifications) {
      if (classification !== "NORMAL_LOCAL") classifications.add(classification);
    }
  }
  if (
    platform === "POWERSHELL" &&
    command === "start-process" &&
    hasOption(tokens, "-verb", "runas")
  ) {
    classifications.add("PRIVILEGE_ESCALATION");
  }
  if (isSystemDestructive(command, tokens, tokens[0] ?? ""))
    classifications.add("SYSTEM_DESTRUCTIVE");
  else if (isDestructive(command, tokens, platform)) classifications.add("DESTRUCTIVE_LOCAL");

  if (command === "git") classifyGit(tokens, classifications);
  if (isNetworkExecutable(command, tokens)) classifications.add("NETWORK_ACCESS");
  if (isRemoteMutation(command, tokens)) {
    classifications.add("REMOTE_MUTATION");
    classifications.add("NETWORK_ACCESS");
  }
  if (classifications.size === 0) classifications.add("NORMAL_LOCAL");
  return { classifications, wrapperDepth: depth };
}

function tokenize(command: string, platform: CommandPlatform): TokenizedCommand {
  const segments: string[][] = [];
  let segment: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const pushToken = () => {
    if (token.length > 0) segment.push(token);
    token = "";
  };
  const pushSegment = () => {
    pushToken();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && platform !== "POWERSHELL") escaped = true;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\" && platform === "POSIX_SH") {
      escaped = true;
      continue;
    }
    if (character === "&" && next === "&") {
      pushSegment();
      index += 1;
    } else if (character === "|" && next === "|") {
      pushSegment();
      index += 1;
    } else if (character === ";" || character === "|") {
      pushSegment();
    } else if (/\s/.test(character)) {
      pushToken();
    } else {
      token += character;
    }
  }
  if (quote !== undefined || escaped) return { segments: [], opaque: true };
  pushSegment();
  return { segments, opaque: false };
}

/**
 * Whether a segment launches another shell whose body must also be analyzed.
 *
 * A nested shell is a wrapper wherever it appears, not only on its native platform: a POSIX host
 * can run `powershell -Command "..."` and any host can run `cmd /c "..."`, and recognizing the
 * wrapper only on its home platform would leave the body unanalysed exactly when the host shell
 * differs from the body shell. `wrapperPlatform` still decides which grammar the body is parsed
 * with, so widening recognition does not widen interpretation.
 */
function isShellWrapper(
  executable: string,
  tokens: readonly string[],
): boolean {
  const name = executable.toLowerCase();
  const flags = tokens.map((token) => token.toLowerCase());
  if (["sh", "bash", "zsh"].includes(name)) return flags.some((flag) => ["-c", "-lc"].includes(flag));
  if (["powershell", "pwsh"].includes(name))
    return flags.some((flag) => ["-command", "-c"].includes(flag));
  return ["cmd", "cmd.exe"].includes(name) && flags.includes("/c");
}

function wrapperBody(tokens: readonly string[], platform: CommandPlatform): string | undefined {
  const flags =
    platform === "POSIX_SH"
      ? ["-c", "-lc"]
      : platform === "POWERSHELL"
        ? ["-command", "-c"]
        : ["/c"];
  const index = tokens.findIndex((token) =>
    flags.includes(platform === "POWERSHELL" ? token.toLowerCase() : token.toLowerCase()),
  );
  return index >= 0 && tokens[index + 1] !== undefined ? tokens[index + 1] : undefined;
}

function wrapperPlatform(executable: string, current: CommandPlatform): CommandPlatform {
  const name = executable.toLowerCase();
  if (["powershell", "pwsh"].includes(name)) return "POWERSHELL";
  if (["cmd", "cmd.exe"].includes(name)) return "CMD";
  if (["sh", "bash", "zsh"].includes(name)) return "POSIX_SH";
  return current;
}

function containsDynamicSyntax(tokens: readonly string[], platform: CommandPlatform): boolean {
  return tokens.some(
    (token) =>
      /\$\(|`|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(token) ||
      token.toLowerCase() === "eval" ||
      (platform === "POWERSHELL" && ["-encodedcommand", "-enc"].includes(token.toLowerCase())),
  );
}

function classifyGit(tokens: readonly string[], classifications: Set<CommandClassification>): void {
  const verb = tokens[1]?.toLowerCase();
  if (verb === undefined) return;
  if (
    [
      "add",
      "commit",
      "checkout",
      "switch",
      "restore",
      "reset",
      "clean",
      "merge",
      "rebase",
      "cherry-pick",
      "revert",
      "tag",
    ].includes(verb)
  ) {
    classifications.add("LOCAL_REPO_MUTATION");
  }
  if (["clone", "fetch", "pull"].includes(verb)) classifications.add("NETWORK_ACCESS");
  if (verb === "push") {
    classifications.add("NETWORK_ACCESS");
    classifications.add("REMOTE_MUTATION");
  }
}

function isNetworkExecutable(command: string, tokens: readonly string[]): boolean {
  if (["curl", "wget", "ssh", "scp", "sftp"].includes(command)) return true;
  return (
    ["npm", "pnpm", "yarn"].includes(command) &&
    ["install", "add", "i"].includes(tokens[1]?.toLowerCase() ?? "")
  );
}

function isRemoteMutation(command: string, tokens: readonly string[]): boolean {
  if (["npm", "pnpm", "yarn"].includes(command) && tokens[1]?.toLowerCase() === "publish")
    return true;
  if (command === "twine" && tokens[1]?.toLowerCase() === "upload") return true;
  return command === "docker" && tokens[1]?.toLowerCase() === "push";
}

/**
 * Host-process terminating executables.
 *
 * ```text
 * taskkill      Windows image/PID termination
 * stop-process  PowerShell cmdlet; `spps` is its own documented alias
 * pkill         POSIX match-and-kill
 * killall       POSIX name-and-kill
 * kill          POSIX signal delivery / PowerShell's alias for Stop-Process
 * ```
 *
 * A shell command cannot prove that the pid, image name or pattern it names resolves to a process
 * the *current Run* owns. The Runtime already holds that proof as `sessionId` + `ownerRunId`, so a
 * shell-level kill is always an ownership bypass rather than an ordinary command. These therefore
 * reuse the existing `SYSTEM_DESTRUCTIVE` classification, whose input-policy outcome is an
 * unconditional DENY — not an approval prompt, because no human approval can turn an unprovable
 * ownership claim into a provable one.
 *
 * No pid lists, image-name exceptions or daemon-pid allow-lists belong here: an exception list is
 * itself the bypass.
 */
const HOST_PROCESS_TERMINATION_EXECUTABLES: ReadonlySet<string> = new Set([
  "taskkill",
  "stop-process",
  "spps",
  "pkill",
  "killall",
  "kill",
]);

function isSystemDestructive(
  command: string,
  tokens: readonly string[],
  executableToken: string,
): boolean {
  if (["shutdown", "reboot", "poweroff", "halt", "mkfs"].includes(command)) return true;
  if (command === "diskpart" && tokens.some((token) => token.toLowerCase() === "clean"))
    return true;
  if (command === "dd" && tokens.some((token) => /^of=\/dev\//i.test(token))) return true;
  if (isHostProcessTermination(command, executableToken)) return true;
  if (command !== "rm" || !hasRecursive(tokens)) return false;
  return tokens.some((token) => ["/", "/*", "~"].includes(token));
}

/**
 * Whether the segment invokes a host-process terminating executable.
 *
 * The invocation must be **bare**: `./scripts/kill` and `node tools/killall.js` name workspace
 * files, not the host's process-termination binary, and denying them would be a false positive on
 * ordinary user code. A path separator in the executable token is that distinction.
 */
function isHostProcessTermination(command: string, executableToken: string): boolean {
  return (
    HOST_PROCESS_TERMINATION_EXECUTABLES.has(command) &&
    !executableToken.includes("/") &&
    !executableToken.includes("\\")
  );
}

function isDestructive(
  command: string,
  tokens: readonly string[],
  platform: CommandPlatform,
): boolean {
  if (command === "rm") return true;
  if (platform === "POWERSHELL" && command === "remove-item")
    return hasRecursive(tokens) && hasForce(tokens);
  if (platform === "CMD" && command === "del")
    return tokens.some((token) => token.toLowerCase() === "/f");
  if (platform === "CMD" && command === "rmdir")
    return tokens.some((token) => token.toLowerCase() === "/s");
  return false;
}

function hasRecursive(tokens: readonly string[]): boolean {
  return tokens.some((token) => /(^|-)r($|f|e)|recursive|\/s/i.test(token));
}

function hasForce(tokens: readonly string[]): boolean {
  return tokens.some((token) => /(^|-)f($|orce)|\/f/i.test(token));
}

function hasOption(tokens: readonly string[], option: string, value: string): boolean {
  const index = tokens.findIndex((token) => token.toLowerCase() === option);
  return index >= 0 && tokens[index + 1]?.toLowerCase() === value;
}

function skipEnvPrefix(tokens: readonly string[]): number {
  let index = 1;
  while (
    index < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!) || tokens[index]!.startsWith("-"))
  )
    index += 1;
  return index;
}

function basename(value: string): string {
  return value.replaceAll("\\", "/").slice(value.replaceAll("\\", "/").lastIndexOf("/") + 1);
}

/**
 * The comparable executable name of one token: basename, lowercased, with a Windows `.exe`
 * suffix folded away so `taskkill.exe` and `taskkill` are the same command.
 *
 * Only `.exe` is folded. `.cmd` / `.bat` / `.js` stay significant, because those names are
 * overwhelmingly workspace scripts rather than host binaries.
 */
function executableName(token: string): string {
  const name = basename(token).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

function orderClassifications(
  values: ReadonlySet<CommandClassification>,
): readonly CommandClassification[] {
  const order: readonly CommandClassification[] = [
    "NORMAL_LOCAL",
    "NETWORK_ACCESS",
    "REMOTE_MUTATION",
    "PRIVILEGE_ESCALATION",
    "LOCAL_REPO_MUTATION",
    "DESTRUCTIVE_LOCAL",
    "SYSTEM_DESTRUCTIVE",
    "OPAQUE_DYNAMIC",
  ];
  const hasSpecificClassification = [...values].some((value) => value !== "NORMAL_LOCAL");
  return order.filter(
    (value) => values.has(value) && (!hasSpecificClassification || value !== "NORMAL_LOCAL"),
  );
}

function boundedPreview(command: string): string {
  if (Buffer.byteLength(command, "utf8") <= MAX_COMMAND_PREVIEW_BYTES) return command;
  let prefix = "";
  for (const character of command) {
    if (
      Buffer.byteLength(`${prefix}${character}\n[command preview truncated]`, "utf8") >
      MAX_COMMAND_PREVIEW_BYTES
    )
      break;
    prefix += character;
  }
  return `${prefix}\n[command preview truncated]`;
}
