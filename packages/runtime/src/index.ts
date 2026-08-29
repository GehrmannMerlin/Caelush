export { LocalRuntime, type LocalRuntimeOptions } from "./local-runtime.js";
export {
  RuntimeError,
  RuntimeUnsupportedError,
  RuntimeWorkspaceError,
  RuntimeBoundaryError,
  RuntimePathNotFoundError,
  RuntimePathTypeError,
  RuntimeBinaryFileError,
  RuntimeInvalidUtf8Error,
  RuntimeFileReadError,
  RuntimeInvalidRangeError,
  RuntimeInvalidPatternError,
  RuntimeDiscoveryError,
  RuntimeSearchUnavailableError,
  RuntimeSearchError,
  RuntimeInvariantError,
} from "./runtime-errors.js";
export type { RuntimeErrorCode } from "./runtime-errors.js";
export {
  LOCAL_RUNTIME_KIND,
  SingleRuntimeResolver,
  createLocalRuntimeResolver,
} from "./runtime-ref.js";
export type { RuntimeResolver } from "./runtime-ref.js";
export type { Runtime } from "./runtime.js";
export type { RuntimeWorkspaceScope } from "./workspace-scope.js";
export {
  MAX_WORKSPACE_PATH_BYTES,
  WorkspacePathResolver,
  type ResolvedWorkspacePath,
} from "./workspace-path.js";
export type {
  RuntimeDirectoryEntry,
  RuntimeFileKind,
  RuntimeFileMetadata,
  RuntimeFileSystem,
  RuntimeTextRead,
} from "./filesystem/types.js";
export { LocalRuntimeFileSystem } from "./filesystem/local-filesystem.js";
export { RuntimePatchError, RuntimePatchUncertainError } from "./patch/errors.js";
export { parsePatch } from "./patch/parser.js";
export { PATCH_LIMITS } from "./patch/types.js";
export type {
  FileVersion,
  PatchChange,
  PatchDocument,
  PatchHunk,
  PatchLine,
  PatchLineKind,
  PatchMutationFileSystem,
  PatchOperation,
  PatchCommitResult,
  PreparedChange,
  PreparedPatch,
  RuntimePatchRequest,
} from "./patch/types.js";
export { isBinarySample } from "./filesystem/binary-detection.js";
export {
  DEFAULT_READ_MODEL_BYTES,
  MAX_READ_LINE_CHARS,
  readBoundedUtf8Text,
} from "./filesystem/text-reader.js";
export type {
  RuntimeFileDiscovery,
  RuntimeFileDiscoveryRequest,
  RuntimeFileDiscoveryResult,
} from "./discovery/file-discovery.js";
export { LocalRuntimeFileDiscovery } from "./discovery/file-discovery.js";
export type {
  RuntimeTextSearch,
  RuntimeTextSearchMatch,
  RuntimeTextSearchRequest,
  RuntimeTextSearchResult,
} from "./search/text-search.js";
export {
  LocalRipgrepRunner,
  MAX_RG_STDERR_BYTES,
  MAX_RG_STDOUT_BYTES,
  RIPGREP_EXECUTABLE,
} from "./search/ripgrep-runner.js";
export { parseRipgrepJson } from "./search/ripgrep-parser.js";
