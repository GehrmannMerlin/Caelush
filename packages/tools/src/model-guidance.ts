import type { ToolName } from "@caelush/protocol";

export interface ToolModelGuidance {
  readonly toolName: ToolName;
  readonly purpose: string;
  readonly whenToUse: string;
  readonly whenNotToUse: string;
  readonly argumentNotes: string;
  readonly sideEffects: string;
  readonly safety: string;
  readonly resultHandling: string;
}

const MAX_GUIDANCE_FIELD_BYTES = 2048;

const GUIDANCE_BY_TOOL: Readonly<Record<string, Omit<ToolModelGuidance, "toolName">>> = {
  read_file: {
    purpose: "Read bounded UTF-8 text.",
    whenToUse: "Known text file contents.",
    whenNotToUse: "Dirs/binary/outside paths.",
    argumentNotes: "Relative path; paginate.",
    sideEffects: "Read-only.",
    safety: "Workspace/UTF-8/size limits.",
    resultHandling: "Lines + truncation.",
  },
  list_directory: {
    purpose: "List directory children.",
    whenToUse: "Directory structure.",
    whenNotToUse: "Recursive discovery or contents.",
    argumentNotes: "Relative path; '.' is root.",
    sideEffects: "Read-only.",
    safety: "Workspace containment applies.",
    resultHandling: "Names/kinds; read as needed.",
  },
  find_files: {
    purpose: "Find files by glob.",
    whenToUse: "Unknown paths or recursion.",
    whenNotToUse: "Contents or outside workspace.",
    argumentNotes: "Relative path; narrow pattern.",
    sideEffects: "Read-only.",
    safety: "Symlinks stay inside boundary.",
    resultHandling: "Check truncation.",
  },
  search_text: {
    purpose: "Search workspace text.",
    whenToUse: "Symbols or exact text.",
    whenNotToUse: "Listing or broad scans.",
    argumentNotes: "Narrow regex; relative path.",
    sideEffects: "Read-only search.",
    safety: "Bad patterns are recoverable.",
    resultHandling: "Matches/truncation.",
  },
  apply_patch: {
    purpose: "Apply verified patch.",
    whenToUse: "Requested inspected changes.",
    whenNotToUse: "Reads/guesses.",
    argumentNotes: "One exact patch document.",
    sideEffects: "Mutates files after guards.",
    safety: "Gate/approval may apply.",
    resultHandling: "Re-read files/diff.",
  },
  exec_command: {
    purpose: "Run command.",
    whenToUse: "Tests/builds/installs/services.",
    whenNotToUse: "Read/list/search.",
    argumentNotes: "cmd and relative workdir.",
    sideEffects: "process/state/network.",
    safety: "Gate/approval for risk.",
    resultHandling: "Output + exit status.",
  },
  write_stdin: {
    purpose: "Write or poll process.",
    whenToUse: "Continue an exec session.",
    whenNotToUse: "Start commands or guess sessions.",
    argumentNotes: "Owned session_id; chars or poll.",
    sideEffects: "May write stdin.",
    safety: "Same-Run session ownership.",
    resultHandling: "Status + exit.",
  },
  git_status: {
    purpose: "Read Git status.",
    whenToUse: "Repo state before/after changes.",
    whenNotToUse: "Non-Git clean claims or mutations.",
    argumentNotes: "Relative pathspec; omit for root.",
    sideEffects: "Read-only.",
    safety: "Runtime determines Git availability.",
    resultHandling: "Clean/branch/entries.",
  },
  git_diff: {
    purpose: "Read bounded Git diff.",
    whenToUse: "Review changes before reporting.",
    whenNotToUse: "Apply changes or trust truncation.",
    argumentNotes: "Scope WORKTREE/STAGED/ALL; path?",
    sideEffects: "Read-only.",
    safety: "Review truncation.",
    resultHandling: "Pair diff with exact file reads.",
  },
};

function freezeGuidance(guidance: ToolModelGuidance): ToolModelGuidance {
  return Object.freeze({ ...guidance });
}

export function createBuiltinToolModelGuidance(toolName: ToolName): ToolModelGuidance {
  const guidance = GUIDANCE_BY_TOOL[toolName];
  if (guidance === undefined) throw new Error(`Missing model guidance for tool ${toolName}.`);
  return freezeGuidance({ toolName, ...guidance });
}

export function cloneToolModelGuidance(guidance: ToolModelGuidance): ToolModelGuidance {
  return freezeGuidance({ ...guidance });
}

export function appendToolModelGuidance(description: string, guidance: ToolModelGuidance): string {
  return [
    description,
    `Purpose: ${guidance.purpose}`,
    `When: ${guidance.whenToUse}`,
    `When not: ${guidance.whenNotToUse}`,
    `Args: ${guidance.argumentNotes}`,
    `Side effects: ${guidance.sideEffects}`,
    `Safety: ${guidance.safety}`,
    `Results: ${guidance.resultHandling}`,
  ].join(" ");
}

export function normalizeToolModelGuidance(
  guidance: ToolModelGuidance,
  expectedToolName: ToolName,
): ToolModelGuidance {
  if (guidance === null || typeof guidance !== "object") {
    throw new Error("model guidance must be an object");
  }
  if (guidance.toolName !== expectedToolName) {
    throw new Error("model guidance tool name must match its definition");
  }
  for (const field of [
    "purpose",
    "whenToUse",
    "whenNotToUse",
    "argumentNotes",
    "sideEffects",
    "safety",
    "resultHandling",
  ] as const) {
    const value = guidance[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`model guidance field ${field} must be non-empty`);
    }
    if (Buffer.byteLength(value, "utf8") > MAX_GUIDANCE_FIELD_BYTES) {
      throw new Error(`model guidance field ${field} is too large`);
    }
  }
  return cloneToolModelGuidance(guidance);
}
