import type { ToolName } from "@caelush/protocol";

export interface ToolModelGuidance {
  readonly toolName: ToolName;
  readonly purpose: string;
  readonly whenToUse: string;
  readonly whenNotToUse: string;
  readonly argumentNotes: string;
  readonly resultHandling: string;
}

const MAX_GUIDANCE_FIELD_BYTES = 2048;

const GUIDANCE_BY_TOOL: Readonly<Record<string, Omit<ToolModelGuidance, "toolName">>> = {
  read_file: {
    purpose: "Read bounded UTF-8 text from one workspace file.",
    whenToUse: "Use when the exact file contents or line range is needed as evidence.",
    whenNotToUse: "Do not use for directories, binary files, or paths outside the workspace.",
    argumentNotes: "Use a workspace-relative path; paginate with offset and limit when needed.",
    resultHandling: "Treat returned lines and truncation metadata as observations; do not invent omitted text.",
  },
  list_directory: {
    purpose: "List immediate children of one workspace directory.",
    whenToUse: "Use to establish directory structure before selecting files or tools.",
    whenNotToUse: "Do not use for recursive discovery or file contents.",
    argumentNotes: "Use path '.' for the workspace root and paginate large directories.",
    resultHandling: "Use names and kinds as observed; follow up with read_file or find_files when necessary.",
  },
  find_files: {
    purpose: "Find workspace files using a bounded glob pattern.",
    whenToUse: "Use when the target file path is unknown or recursive discovery is needed.",
    whenNotToUse: "Do not use to inspect file contents or to search outside the workspace.",
    argumentNotes: "Use a workspace-relative search path and a narrow glob pattern.",
    resultHandling: "Respect truncation and continue with narrower searches when results are incomplete.",
  },
  search_text: {
    purpose: "Search UTF-8 workspace text with a bounded regular expression.",
    whenToUse: "Use to locate symbols, references, or exact text before editing or reporting.",
    whenNotToUse: "Do not treat a search result as complete when it is truncated.",
    argumentNotes: "Use a narrow pattern and optional include glob; paths are workspace-relative.",
    resultHandling: "Cite observed path and line matches; read the relevant file before making a change claim.",
  },
  apply_patch: {
    purpose: "Apply a verified bounded patch to workspace text files.",
    whenToUse: "Use only when a requested mutation is supported by inspected context.",
    whenNotToUse: "Do not use for exploratory reads, unrelated cleanup, or guessed context.",
    argumentNotes: "Send one complete patch document with exact context and workspace-relative paths.",
    resultHandling: "Confirm the patch result and re-read affected files before claiming success.",
  },
  exec_command: {
    purpose: "Run a bounded local command in the workspace.",
    whenToUse: "Use for an explicit project check or operation that cannot be done with a native tool.",
    whenNotToUse: "Do not use arbitrary commands when a native filesystem or Git tool is sufficient.",
    argumentNotes: "Use explicit command text and a workspace-relative workdir; never request arbitrary environment or timeout settings.",
    resultHandling: "Inspect exit status and bounded output; a non-zero exit is evidence of failure, not a reason to hide it.",
  },
  write_stdin: {
    purpose: "Send input to or poll a managed local process session.",
    whenToUse: "Use only with a session_id returned by exec_command in the same run.",
    whenNotToUse: "Do not guess session IDs or use it as a substitute for starting a command.",
    argumentNotes: "Preserve the opaque session_id and send only the required characters or an empty poll.",
    resultHandling: "Use status, exit code, and bounded output to decide whether the process is complete.",
  },
  git_status: {
    purpose: "Read bounded Git working-tree status.",
    whenToUse: "Use to establish repository state before or after a requested change.",
    whenNotToUse: "Do not use as proof that a non-Git workspace is clean.",
    argumentNotes: "Omit path for the workspace root or use a workspace-relative pathspec.",
    resultHandling: "Treat clean, branch, and entries as observations; report a non-Git error explicitly.",
  },
  git_diff: {
    purpose: "Read a bounded, read-only Git diff.",
    whenToUse: "Use to inspect the actual change set before reporting or verifying a mutation.",
    whenNotToUse: "Do not use to apply changes or to infer content when the diff is truncated.",
    argumentNotes: "Choose WORKTREE, STAGED, or ALL and optionally provide a workspace-relative pathspec.",
    resultHandling: "Review the diff and truncation metadata; pair it with file reads for exact evidence.",
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
