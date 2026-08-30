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
  if (isShellWrapper(executable, tokens, platform)) {
    const body = wrapperBody(tokens, platform);
    const nextDepth = depth + 1;
    if (nextDepth > MAX_COMMAND_WRAPPER_DEPTH || body === undefined) {
      classifications.add("OPAQUE_DYNAMIC");
      return { classifications, wrapperDepth: nextDepth };
    }
    const nested = analyzeText(body, wrapperPlatform(executable, platform), nextDepth);
    for (const classification of nested.classifications) classifications.add(classification);
    return { classifications, wrapperDepth: nested.wrapperDepth };
  }

  const command = executable.toLowerCase();
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
  if (isSystemDestructive(command, tokens)) classifications.add("SYSTEM_DESTRUCTIVE");
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

function isShellWrapper(
  executable: string,
  tokens: readonly string[],
  platform: CommandPlatform,
): boolean {
  const name = executable.toLowerCase();
  if (platform === "POSIX_SH" && ["sh", "bash", "zsh"].includes(name)) {
    return tokens.some((token) => token === "-c" || token === "-lc");
  }
  if (platform === "POWERSHELL" && ["powershell", "pwsh"].includes(name)) {
    return tokens.some(
      (token) => token.toLowerCase() === "-command" || token.toLowerCase() === "-c",
    );
  }
  return (
    platform === "CMD" &&
    ["cmd", "cmd.exe"].includes(name) &&
    tokens.some((token) => token.toLowerCase() === "/c")
  );
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
  return current === "POWERSHELL" ? "POWERSHELL" : "POSIX_SH";
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

function isSystemDestructive(command: string, tokens: readonly string[]): boolean {
  if (["shutdown", "reboot", "poweroff", "halt", "mkfs"].includes(command)) return true;
  if (command === "diskpart" && tokens.some((token) => token.toLowerCase() === "clean"))
    return true;
  if (command === "dd" && tokens.some((token) => /^of=\/dev\//i.test(token))) return true;
  if (command !== "rm" || !hasRecursive(tokens)) return false;
  return tokens.some((token) => ["/", "/*", "~"].includes(token));
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
