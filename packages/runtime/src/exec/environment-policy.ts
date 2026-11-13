import process from "node:process";
import path from "node:path";

export type ChildEnvironmentPlatform = "posix" | "win32";

const POSIX_COMPATIBLE_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
]);

const WINDOWS_COMPATIBLE_NAMES = new Set([
  "PATH",
  // System-location variables. `SYSTEMROOT`/`WINDIR` locate the OS, and `SYSTEMDRIVE` is required by the
  // .NET runtime to expand registry values such as `%SystemDrive%\ProgramData\...`. When it is absent the
  // token is left unexpanded and resolves RELATIVE to the child's working directory, which silently
  // materialises a literal `%SystemDrive%` directory inside the workspace.
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "LANG",
  "TERM",
]);

const CREDENTIAL_NAMES = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "PYPI_TOKEN",
  "DOCKER_AUTH_CONFIG",
  "KUBECONFIG",
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
  "GIT_ASKPASS",
  "GPG_AGENT_INFO",
  "DATABASE_URL",
]);

const INJECTION_NAMES = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "CDPATH",
]);

const PROXY_NAMES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);

function normalizedName(name: string, platform: ChildEnvironmentPlatform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

function hasCredentialName(name: string): boolean {
  return (
    CREDENTIAL_NAMES.has(name) ||
    /(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)$/.test(name) ||
    (/^(?:AZURE|GOOGLE)_/.test(name) && /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name))
  );
}

function hasCredentialUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\/[^/@\s]+(?::[^/@\s]*)?@/i.test(value);
}

function isBlockedName(name: string, value: string): boolean {
  return (
    hasCredentialName(name) ||
    INJECTION_NAMES.has(name) ||
    name === "RIPGREP_CONFIG_PATH" ||
    (PROXY_NAMES.has(name) && hasCredentialUrl(value))
  );
}

function isCompatibleName(name: string, platform: ChildEnvironmentPlatform): boolean {
  const names = platform === "win32" ? WINDOWS_COMPATIBLE_NAMES : POSIX_COMPATIBLE_NAMES;
  return names.has(name) || name.startsWith("LC_");
}

function sourceEnvironmentValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(source).find(([candidate]) => candidate.toUpperCase() === name)?.[1];
}

function isWithinWindowsDirectory(root: string, candidate: string): boolean {
  const relative = path.win32.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.win32.sep}`) &&
      !path.win32.isAbsolute(relative))
  );
}

function windowsPowerShellModulePath(source: NodeJS.ProcessEnv): string {
  const sourceSystemRoot =
    sourceEnvironmentValue(source, "SYSTEMROOT") ??
    sourceEnvironmentValue(source, "WINDIR") ??
    "C:\\Windows";
  const userProfile = sourceEnvironmentValue(source, "USERPROFILE");
  const trustedSystemRoot =
    path.win32.isAbsolute(sourceSystemRoot) &&
    (userProfile === undefined || !isWithinWindowsDirectory(userProfile, sourceSystemRoot))
      ? sourceSystemRoot
      : "C:\\Windows";
  const machineRoots = [
    trustedSystemRoot,
    sourceEnvironmentValue(source, "PROGRAMFILES"),
    sourceEnvironmentValue(source, "PROGRAMFILES(X86)"),
  ].filter(
    (root): root is string =>
      root !== undefined &&
      path.win32.isAbsolute(root) &&
      (userProfile === undefined || !isWithinWindowsDirectory(userProfile, root)),
  );
  const modulePathEntries = new Map<string, string>();
  const addMachineModulePath = (value: string) => {
    const normalized = path.win32.normalize(value.trim());
    if (
      normalized.length === 0 ||
      !path.win32.isAbsolute(normalized) ||
      !machineRoots.some((root) => isWithinWindowsDirectory(root, normalized))
    ) {
      return;
    }
    const key = normalized.toLowerCase();
    if (!modulePathEntries.has(key)) modulePathEntries.set(key, normalized);
  };

  const sourceModulePath = sourceEnvironmentValue(source, "PSMODULEPATH");
  for (const entry of sourceModulePath?.split(path.win32.delimiter) ?? []) {
    addMachineModulePath(entry);
  }
  addMachineModulePath(
    path.win32.join(trustedSystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  );
  return [...modulePathEntries.values()].join(path.win32.delimiter);
}

function createEnvironment(
  source: NodeJS.ProcessEnv,
  platform: ChildEnvironmentPlatform,
  structured: boolean,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [originalName, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = normalizedName(originalName, platform);
    if (seen.has(name) || isBlockedName(name, value)) continue;
    if (!isCompatibleName(name, platform)) continue;
    if (structured && (name === "HOME" || name === "USERPROFILE")) continue;
    result[originalName] = value;
    seen.add(name);
  }
  if (platform === "win32" && !structured) {
    // PowerShell hangs before executing a command when PSModulePath is absent on hosted Windows
    // runners. Keep only module paths under machine installation roots; never inherit the host's
    // per-user module search paths into an Agent child.
    result.PSModulePath = windowsPowerShellModulePath(source);
  }
  return result;
}

export function createAgentProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | ChildEnvironmentPlatform = process.platform,
): NodeJS.ProcessEnv {
  return createEnvironment(source, platform === "win32" ? "win32" : "posix", false);
}

export function createStructuredHelperEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | ChildEnvironmentPlatform = process.platform,
): NodeJS.ProcessEnv {
  return createEnvironment(source, platform === "win32" ? "win32" : "posix", true);
}

export function isCredentialBearingEnvironmentVariable(name: string): boolean {
  return hasCredentialName(name.toUpperCase());
}
