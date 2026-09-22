/**
 * The legacy Coding builtin result helpers — a compatibility re-export.
 *
 * ```text
 * @caelush/tools/src/builtins/result.ts     this file: the legacy names over the target helpers
 *        └── re-exports ──▶  @caelush/coding-agent  tools/builtins/result.ts
 * ```
 *
 * Phase 4E moved the nine builtins' result vocabulary to the Coding product layer: the two details
 * schemas, the six argument bounds, `errorResult` / `successResult`, `positiveBoundedInteger`,
 * `runtimeErrorToResult` and `safeRuntimeMessage`. Every one of them describes *what a Coding Tool
 * tells a model*, which is Coding business knowledge, so a second copy here would be a second answer to
 * "what does this Tool report".
 *
 * ## What deliberately did not come back
 *
 * The module this replaces also owned `withRuntimeScope`, `RuntimeResolver` and `RuntimeWorkspaceScope`
 * — the per-call runtime resolution every legacy builtin performed itself. None of that has a place in
 * the compatibility layer any more: a Tool receives a narrow Operations port, the port is built once by
 * the Coding factory, and the workspace is opened inside `operations/runtime-adapters/`. Re-exporting
 * `withRuntimeScope` would restore exactly the broad capability the round removed, so it is gone.
 */
export {
  errorResult,
  EXEC_OUTPUT_SCHEMA,
  FIND_FILES_DEFAULT_LIMIT,
  FIND_FILES_MAX_LIMIT,
  LIST_DIRECTORY_DEFAULT_LIMIT,
  LIST_DIRECTORY_MAX_LIMIT,
  MAX_FIND_PATTERN_BYTES,
  MAX_SEARCH_GLOB_BYTES,
  MAX_SEARCH_MATCH_CHARS,
  positiveBoundedInteger,
  READ_FILE_DEFAULT_LIMIT,
  READ_FILE_MAX_LIMIT,
  READ_ONLY_OUTPUT_SCHEMA,
  runtimeErrorToResult,
  safeRuntimeMessage,
  SEARCH_TEXT_DEFAULT_LIMIT,
  SEARCH_TEXT_MAX_LIMIT,
  successResult,
} from "@caelush/coding-agent";
