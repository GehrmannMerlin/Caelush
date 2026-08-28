import path from "node:path";
import { ContextInstructionError } from "./errors.js";
import type { ContextFileSystem } from "./filesystem.js";
import { ancestors } from "./project-root.js";
import type { WorkspaceScope } from "./workspace.js";
import { isWithinWorkspace } from "./workspace.js";

export type InstructionKind = "OVERRIDE" | "AGENTS" | "FALLBACK";

export interface ProjectInstruction {
  readonly path: string;
  readonly relativePath: string;
  readonly kind: InstructionKind;
  readonly depth: number;
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface ProjectInstructions {
  readonly entries: readonly ProjectInstruction[];
  readonly totalBytes: number;
  readonly maxBytes: number;
}

export interface ProjectInstructionDiscoveryOptions {
  readonly fallbackInstructionFilenames?: readonly string[];
  readonly maxBytes?: number;
}

interface Candidate {
  readonly filename: string;
  readonly kind: InstructionKind;
}

const defaultCandidates: readonly Candidate[] = [
  { filename: "AGENTS.override.md", kind: "OVERRIDE" },
  { filename: "AGENTS.md", kind: "AGENTS" },
];

function candidates(fallbackFilenames: readonly string[]): readonly Candidate[] {
  return [
    ...defaultCandidates,
    ...fallbackFilenames.map((filename) => ({ filename, kind: "FALLBACK" as const })),
  ];
}

function instructionError(message: string, cause?: unknown): ContextInstructionError {
  return new ContextInstructionError(message, cause === undefined ? undefined : { cause });
}

export class ProjectInstructionDiscovery {
  constructor(private readonly filesystem: ContextFileSystem) {}

  async discover(
    scope: WorkspaceScope,
    projectRoot: string,
    cwd: string,
    options: ProjectInstructionDiscoveryOptions = {},
  ): Promise<ProjectInstructions> {
    const maxBytes = options.maxBytes ?? 32 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw instructionError("instruction maxBytes must be a non-negative safe integer");
    }
    if (!isWithinWorkspace(scope.realRoot, projectRoot) || !isWithinWorkspace(projectRoot, cwd)) {
      throw instructionError("project instructions are outside the workspace scope");
    }
    const fallbackFilenames = options.fallbackInstructionFilenames ?? ["CLAUDE.md"];
    const directories = [...ancestors(cwd, projectRoot)].reverse();
    const entries: ProjectInstruction[] = [];
    let remaining = maxBytes;
    for (const [depth, directory] of directories.entries()) {
      if (remaining === 0) break;
      const selected = await this.selectCandidate(directory, candidates(fallbackFilenames));
      if (selected === null) continue;
      const candidatePath = path.join(directory, selected.filename);
      const realCandidatePath = await this.safeRealpath(candidatePath);
      if (!isWithinWorkspace(scope.realRoot, realCandidatePath)) {
        throw instructionError(`instruction resolves outside workspace: ${candidatePath}`);
      }
      let file;
      try {
        file = await this.filesystem.readTextFile(candidatePath, { maxBytes: remaining });
      } catch (error) {
        throw instructionError(`could not read project instruction: ${candidatePath}`, error);
      }
      if (file.text.trim() === "") continue;
      entries.push({
        path: candidatePath,
        relativePath: path.relative(projectRoot, candidatePath),
        kind: selected.kind,
        depth,
        content: file.text,
        bytes: file.bytes,
        truncated: file.truncated,
      });
      remaining = Math.max(0, remaining - file.bytes);
      if (file.truncated || file.bytes === 0) break;
    }
    return { entries, totalBytes: maxBytes - remaining, maxBytes };
  }

  private async selectCandidate(
    directory: string,
    possibleCandidates: readonly Candidate[],
  ): Promise<Candidate | null> {
    for (const candidate of possibleCandidates) {
      const candidatePath = path.join(directory, candidate.filename);
      const metadata = await this.filesystem.getMetadata(candidatePath);
      if (metadata === null) continue;
      if (metadata.kind === "DIRECTORY") {
        throw instructionError(`project instruction is not a file: ${candidatePath}`);
      }
      return candidate;
    }
    return null;
  }

  private async safeRealpath(candidatePath: string): Promise<string> {
    try {
      return await this.filesystem.realpath(candidatePath);
    } catch (error) {
      throw instructionError(`could not resolve project instruction: ${candidatePath}`, error);
    }
  }
}
