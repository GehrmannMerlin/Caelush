import path from "node:path";

import { RuntimeGitError, type Runtime, type RuntimeWorkspaceScope } from "@caelush/runtime";
import type { WorkspaceRef } from "@caelush/protocol";

import type {
  CodingRuntimeFactsPort,
  CodingWorkspacePort,
  GitStateContextPort,
  ProjectInstructionContextPort,
  ProjectMetadataContextPort,
  RelevantFileContextPort,
} from "./ports.js";

export interface LocalCodingContextPorts {
  readonly workspace: CodingWorkspacePort;
  readonly runtimeFacts: CodingRuntimeFactsPort;
  readonly projectInstructions: ProjectInstructionContextPort;
  readonly projectMetadata: ProjectMetadataContextPort;
  readonly relevantFiles: RelevantFileContextPort;
  readonly gitState: GitStateContextPort;
}

export interface LocalCodingContextPortOptions {
  readonly runtime: Runtime;
  readonly workspace: WorkspaceRef;
  readonly cwd?: string;
  readonly explicitPaths?: readonly string[];
}

/**
 * Runtime-backed Coding Context projections. The implementation deliberately
 * returns safe, bounded facts; Source providers remain responsible for turning
 * those facts into Agent ContextItems.
 */
export function createLocalCodingContextPorts(
  options: LocalCodingContextPortOptions,
): LocalCodingContextPorts {
  const scope = async (): Promise<RuntimeWorkspaceScope> =>
    options.runtime.openWorkspace(options.workspace);
  return Object.freeze({
    workspace: {
      async describe() {
        const opened = await scope();
        const cwdRef = relativeRef(opened, options.cwd ?? opened.logicalRoot);
        return {
          workspaceId: options.workspace.id,
          projectId: options.workspace.id,
          workspaceRef: `workspace:${options.workspace.id}`,
          projectRef: `project:${options.workspace.id}`,
          cwdRef,
          runtimeKind: "local",
          safeMetadata: Object.freeze({ root: "workspace", cwd: cwdRef }),
        };
      },
    },
    runtimeFacts: {
      async read(input: Parameters<CodingRuntimeFactsPort["read"]>[0]) {
        const opened = await scope();
        const status = await readGitStatus(opened, input.signal);
        return {
          sourceRef: `runtime:${options.workspace.id}`,
          version: "local-runtime-v1",
          facts: Object.freeze([
            `runtimeKind=local`,
            `workspace=${options.workspace.id}`,
            `gitRepository=${String(status !== undefined)}`,
            `gitClean=${status === undefined ? "unknown" : String(status.clean)}`,
            `changedPathCount=${String(status?.entries.length ?? 0)}`,
          ]),
        };
      },
    },
    projectInstructions: {
      async load(input: Parameters<ProjectInstructionContextPort["load"]>[0]) {
        const opened = await scope();
        return loadInstructions(opened, options.cwd, input.signal);
      },
    },
    projectMetadata: {
      async load() {
        const opened = await scope();
        const metadata = await opened.filesystem.getMetadata(opened.logicalRoot);
        return {
          sourceRef: `project:${options.workspace.id}`,
          version: "runtime-metadata-v1",
          metadata: Object.freeze({
            workspaceId: options.workspace.id,
            rootKind: metadata?.kind ?? "MISSING",
            rootBytes: String(metadata?.sizeBytes ?? 0),
          }),
        };
      },
    },
    relevantFiles: {
      async load(input: Parameters<RelevantFileContextPort["load"]>[0]) {
        const opened = await scope();
        return loadRelevantFiles(opened, input.identity.goal, options.explicitPaths, input.signal);
      },
    },
    gitState: {
      async read(input: Parameters<GitStateContextPort["read"]>[0]) {
        const opened = await scope();
        const status = await readGitStatus(opened, input.signal);
        return {
          sourceRef: `git:${options.workspace.id}`,
          version: "runtime-git-v1",
          ...(status === undefined || status.branch === undefined ? {} : { branch: status.branch }),
          changedPaths: Object.freeze(status?.entries.map((entry) => entry.path) ?? []),
          summary:
            status === undefined
              ? "repository=none clean=unknown ahead=0 behind=0"
              : `clean=${String(status.clean)} ahead=${String(status.ahead)} behind=${String(status.behind)}`,
        };
      },
    },
  });
}

type LocalGitStatus = Awaited<ReturnType<RuntimeWorkspaceScope["git"]["status"]>>;

async function readGitStatus(
  scope: RuntimeWorkspaceScope,
  signal: AbortSignal,
): Promise<LocalGitStatus | undefined> {
  try {
    return await scope.git.status({ limit: 128, signal });
  } catch (error) {
    if (error instanceof RuntimeGitError && error.code === "NOT_A_GIT_REPOSITORY") {
      return undefined;
    }
    throw error;
  }
}

async function loadInstructions(
  scope: RuntimeWorkspaceScope,
  configuredCwd: string | undefined,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<ProjectInstructionContextPort["load"]>>> {
  const cwd = resolveCwd(scope, configuredCwd);
  const directories = ancestorDirectories(cwd, scope.logicalRoot);
  const entries: { relativePath: string; kind: string; content: string }[] = [];
  let remaining = 32 * 1024;
  for (const directory of directories) {
    if (remaining <= 0) break;
    for (const [name, kind] of [
      ["AGENTS.override.md", "OVERRIDE"],
      ["AGENTS.md", "AGENTS"],
      ["CLAUDE.md", "FALLBACK"],
    ] as const) {
      if (signal.aborted) throwAbort();
      const candidate = path.join(directory, name);
      const metadata = await scope.filesystem.getMetadata(candidate);
      if (metadata?.kind !== "FILE") continue;
      const real = await scope.filesystem.realpath(candidate);
      if (!inside(scope.realRoot, real)) throw new Error("instruction escapes workspace");
      const read = await scope.filesystem.readTextFile(candidate, {
        offset: 0,
        limit: remaining,
        maxBytes: remaining,
      });
      const content = read.lines.join("\n");
      if (content.trim().length === 0) continue;
      entries.push({
        relativePath: path.relative(scope.logicalRoot, candidate).replaceAll("\\", "/"),
        kind,
        content,
      });
      remaining = Math.max(0, remaining - read.bytesReturned);
      break;
    }
  }
  return {
    sourceRef: `instructions:${scope.logicalRoot}`,
    version: "runtime-instructions-v1",
    entries: Object.freeze(entries),
  };
}

async function loadRelevantFiles(
  scope: RuntimeWorkspaceScope,
  goal: string,
  explicitPaths: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<RelevantFileContextPort["load"]>>> {
  const gitIgnoreRules = await loadGitIgnoreRules(scope);
  const explicit = new Set(
    (explicitPaths ?? [])
      .map((value) => relativeExplicitPath(scope, value))
      .filter((value): value is string => value !== undefined),
  );
  const discovered = await scope.discovery.find({
    cwd: scope.logicalRoot,
    pattern: "**/*",
    limit: 64,
  });
  const goalWords = goal
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
  const candidates = [...new Set([...explicit, ...discovered.files])]
    .map((candidate) => candidate.replaceAll("\\", "/"))
    .filter(
      (candidate) =>
        isSafeRelative(candidate) &&
        !sensitive(candidate) &&
        !instructionFile(candidate) &&
        candidate !== ".gitignore" &&
        !isGitIgnored(candidate, gitIgnoreRules),
    )
    .sort(
      (left, right) =>
        score(right, goalWords, explicit) - score(left, goalWords, explicit) ||
        left.localeCompare(right),
    );
  const sections: {
    relativePath: string;
    sourceRef: string;
    version: string;
    content: string;
    tokenEstimate: number;
    bytesIncluded: number;
    truncated: boolean;
    maxReadBytes: number;
  }[] = [];
  let totalTokens = 0;
  for (const relative of candidates) {
    if (signal.aborted) throwAbort();
    if (sections.length >= 12 || totalTokens >= 12_000) break;
    const resolved = await scope.pathResolver.resolveExisting(relative);
    if (resolved.kind !== "FILE" || sensitive(relative)) continue;
    const read = await scope.filesystem.readTextFile(resolved.absolutePath, {
      offset: 0,
      limit: 262_144,
      maxBytes: 262_144,
    });
    const content = read.lines.join("\n");
    const tokenEstimate = Math.max(
      128,
      Math.ceil(new TextEncoder().encode(content).byteLength / 3),
    );
    if (tokenEstimate > 4_000 || totalTokens + tokenEstimate > 12_000) continue;
    sections.push({
      relativePath: relative,
      sourceRef: `file:${relative}`,
      version: "runtime-relevant-file-v1",
      content,
      tokenEstimate,
      bytesIncluded: read.bytesReturned,
      truncated: read.truncated,
      maxReadBytes: 262_144,
    });
    totalTokens += tokenEstimate;
  }
  return { sections: Object.freeze(sections) };
}

function resolveCwd(scope: RuntimeWorkspaceScope, cwd: string | undefined): string {
  const resolved = cwd === undefined ? scope.logicalRoot : path.resolve(scope.logicalRoot, cwd);
  if (!inside(scope.logicalRoot, resolved)) throw new Error("cwd escapes workspace");
  return resolved;
}

function ancestorDirectories(cwd: string, root: string): readonly string[] {
  const result: string[] = [];
  let current = path.normalize(cwd);
  const normalizedRoot = path.normalize(root);
  while (inside(normalizedRoot, current)) {
    result.push(current);
    if (current === normalizedRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result.reverse();
}

function relativeRef(scope: RuntimeWorkspaceScope, value: string): string {
  const resolved = path.resolve(scope.logicalRoot, value);
  if (!inside(scope.logicalRoot, resolved)) throw new Error("path escapes workspace");
  return path.relative(scope.logicalRoot, resolved).replaceAll("\\", "/") || ".";
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(target));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function isSafeRelative(value: string): boolean {
  const segments = value.split("/").filter(Boolean);
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !segments.includes("..") &&
    !segments.some((segment) => HARD_EXCLUDED_DIRECTORIES.has(segment.toLowerCase()))
  );
}

function sensitive(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    /(^|\/)(?:\.env(?:\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key|credentials\.json)$/.test(
      normalized,
    ) ||
    [".npmrc", ".pypirc", ".netrc", ".git-credentials", ".authinfo"].includes(basename) ||
    [".aws/credentials", ".kube/config", ".docker/config.json"].includes(normalized) ||
    normalized.split("/").includes(".ssh")
  );
}

function instructionFile(value: string): boolean {
  return ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"].includes(
    value.slice(value.lastIndexOf("/") + 1),
  );
}

const HARD_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".worktrees",
  "node_modules",
  ".pnpm",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  "coverage",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "vendor",
]);

interface GitIgnoreRule {
  readonly baseRelative: string;
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
}

async function loadGitIgnoreRules(scope: RuntimeWorkspaceScope): Promise<readonly GitIgnoreRule[]> {
  const discovered = await scope.discovery.find({
    cwd: scope.logicalRoot,
    pattern: "**/.gitignore",
    limit: 128,
  });
  const rules: GitIgnoreRule[] = [];
  for (const candidate of discovered.files) {
    const relative = candidate.replaceAll("\\", "/");
    if (
      !isSafeRelative(relative) ||
      (!relative.endsWith("/.gitignore") && relative !== ".gitignore")
    ) {
      continue;
    }
    const resolved = await scope.pathResolver.resolveExisting(relative);
    if (resolved.kind !== "FILE") continue;
    const real = await scope.filesystem.realpath(resolved.absolutePath);
    if (!inside(scope.realRoot, real)) throw new Error("gitignore escapes workspace");
    const read = await scope.filesystem.readTextFile(resolved.absolutePath, {
      offset: 0,
      limit: 131_072,
      maxBytes: 131_072,
    });
    if (read.truncated) throw new Error("gitignore exceeds bounded Context input");
    rules.push(...parseGitIgnore(read.lines.join("\n"), path.posix.dirname(relative)));
  }
  return Object.freeze(rules);
}

function relativeExplicitPath(scope: RuntimeWorkspaceScope, value: string): string | undefined {
  const resolved = path.resolve(scope.logicalRoot, value);
  if (!inside(scope.logicalRoot, resolved)) return undefined;
  return path.relative(scope.logicalRoot, resolved).replaceAll("\\", "/") || ".";
}

function parseGitIgnore(text: string, baseRelative: string): readonly GitIgnoreRule[] {
  const rules: GitIgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const withoutNegation = negated ? line.slice(1) : line;
    const directoryOnly = withoutNegation.endsWith("/");
    const pattern = withoutNegation.replace(/^\/+|\/+$/gu, "");
    if (pattern.length === 0) continue;
    rules.push({ baseRelative, pattern, negated, directoryOnly });
  }
  return rules;
}

function isGitIgnored(relativePath: string, rules: readonly GitIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (!isWithinRelative(rule.baseRelative, relativePath)) continue;
    const local = relativePath.slice(rule.baseRelative === "." ? 0 : rule.baseRelative.length + 1);
    if (matchesGitIgnorePattern(local, rule.pattern, rule.directoryOnly)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function isWithinRelative(base: string, candidate: string): boolean {
  return base === "." || candidate === base || candidate.startsWith(`${base}/`);
}

function matchesGitIgnorePattern(
  relativePath: string,
  pattern: string,
  directoryOnly: boolean,
): boolean {
  const expression = globToRegExp(pattern, !pattern.includes("/"), directoryOnly);
  return expression.test(relativePath);
}

function globToRegExp(pattern: string, matchAnySegment: boolean, directoryOnly: boolean): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  if (matchAnySegment) source = `(?:^|/)${source}`;
  else source = `^${source}`;
  if (directoryOnly || !matchAnySegment) source += "(?:/.*)?$";
  else source += "$";
  return new RegExp(source);
}

function score(value: string, words: readonly string[], explicit: ReadonlySet<string>): number {
  if (explicit.has(value)) return 1_000_000;
  const lower = value.toLowerCase();
  return words.reduce((total, word) => total + (lower.includes(word) ? 10 : 0), 0);
}

function throwAbort(): never {
  const error = new Error("Coding Context loading was cancelled.");
  error.name = "AbortError";
  throw error;
}
