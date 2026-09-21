import type { ToolName } from "@caelush/protocol";

/**
 * The Coding Tool prompt snippets.
 *
 * ```text
 * legacy   ToolModelGuidance  →  appended into AIToolSpec.description by the registry builder
 * target   promptSnippet      →  ToolPromptContextProvider  →  ContextEngine  →  model context
 * ```
 *
 * ## Why this moved
 *
 * Usage guidance used to be concatenated onto the Tool's `description`, which meant it travelled inside
 * the *provider tool definition*. That has three costs: the guidance is counted against the tool-catalog
 * byte budget rather than the context budget, it is delivered whether or not the Tool is actually
 * exposed for this Run, and it cannot be reasoned about as context because it is not context.
 *
 * A `promptSnippet` is context-only data. It reaches the model through the Context system, which means it
 * is budgeted there, filtered to the *active* tool set, and delivered exactly once.
 *
 * ## These strings are the legacy guidance, re-rendered not rewritten
 *
 * The prompt guidance must not be lost in the move, and it must not be reinvented either. Each snippet
 * below is the same eight legacy fields — purpose, when to use, when not to use, argument notes, side
 * effects, safety, result handling — rendered into one deterministic block under stable headings. The
 * legacy `ToolModelGuidance` module remains the compatibility source of truth for a legacy consumer that
 * still asks for the structured fields; this module is the canonical text a model now receives.
 *
 * ## Purity and bounds
 *
 * A snippet is pure data: deterministic, static per Tool, bounded, and free of any live value. It never
 * contains a current working directory, a secret, live output or approval state, because it is a constant
 * compiled into the definition rather than a rendering of the moment.
 */

/** One snippet's byte bound. The legacy per-field bound was 2048; this is the rendered whole. */
export const MAX_PROMPT_SNIPPET_BYTES = 4096;

/** The total bound for all snippets in one context build. Enforced by the prompt provider. */
export const MAX_TOOL_PROMPT_TOTAL_BYTES = 24 * 1024;

interface SnippetSource {
  readonly purpose: string;
  readonly whenToUse: string;
  readonly whenNotToUse: string;
  readonly argumentNotes: string;
  readonly sideEffects: string;
  readonly safety: string;
  readonly resultHandling: string;
}

const SNIPPET_SOURCE: Readonly<Record<string, SnippetSource>> = {
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

/** Render one Tool's guidance into its bounded context block. */
function renderSnippet(toolName: string, source: SnippetSource): string {
  return [
    `${toolName}`,
    `Purpose: ${source.purpose}`,
    `When: ${source.whenToUse}`,
    `When not: ${source.whenNotToUse}`,
    `Args: ${source.argumentNotes}`,
    `Side effects: ${source.sideEffects}`,
    `Safety: ${source.safety}`,
    `Results: ${source.resultHandling}`,
  ].join("\n");
}

export const READ_FILE_PROMPT_SNIPPET = renderSnippet("read_file", SNIPPET_SOURCE.read_file!);
export const LIST_DIRECTORY_PROMPT_SNIPPET = renderSnippet(
  "list_directory",
  SNIPPET_SOURCE.list_directory!,
);
export const FIND_FILES_PROMPT_SNIPPET = renderSnippet("find_files", SNIPPET_SOURCE.find_files!);
export const SEARCH_TEXT_PROMPT_SNIPPET = renderSnippet("search_text", SNIPPET_SOURCE.search_text!);
export const APPLY_PATCH_PROMPT_SNIPPET = renderSnippet("apply_patch", SNIPPET_SOURCE.apply_patch!);
export const EXEC_COMMAND_PROMPT_SNIPPET = renderSnippet(
  "exec_command",
  SNIPPET_SOURCE.exec_command!,
);
export const WRITE_STDIN_PROMPT_SNIPPET = renderSnippet("write_stdin", SNIPPET_SOURCE.write_stdin!);
export const GIT_STATUS_PROMPT_SNIPPET = renderSnippet("git_status", SNIPPET_SOURCE.git_status!);
export const GIT_DIFF_PROMPT_SNIPPET = renderSnippet("git_diff", SNIPPET_SOURCE.git_diff!);

/** Every Coding snippet by Tool name, for a provider that selects by the active tool set. */
export const CODING_TOOL_PROMPT_SNIPPETS: Readonly<Record<string, string>> = Object.freeze({
  read_file: READ_FILE_PROMPT_SNIPPET,
  list_directory: LIST_DIRECTORY_PROMPT_SNIPPET,
  find_files: FIND_FILES_PROMPT_SNIPPET,
  search_text: SEARCH_TEXT_PROMPT_SNIPPET,
  apply_patch: APPLY_PATCH_PROMPT_SNIPPET,
  exec_command: EXEC_COMMAND_PROMPT_SNIPPET,
  write_stdin: WRITE_STDIN_PROMPT_SNIPPET,
  git_status: GIT_STATUS_PROMPT_SNIPPET,
  git_diff: GIT_DIFF_PROMPT_SNIPPET,
});

/**
 * The snippet for one Tool, or `undefined` for a Tool that has none.
 *
 * A generic `AgentTool` a host registered has no Coding snippet, and returning `undefined` rather than a
 * placeholder is what keeps an unknown Tool out of the Coding guidance block.
 */
export function promptSnippetFor(toolName: ToolName): string | undefined {
  const snippet = CODING_TOOL_PROMPT_SNIPPETS[toolName];
  if (snippet === undefined) return undefined;
  return Buffer.byteLength(snippet, "utf8") > MAX_PROMPT_SNIPPET_BYTES ? undefined : snippet;
}
