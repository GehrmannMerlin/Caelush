export { LocalRuntime, type LocalRuntimeOptions } from "./local-runtime.js";
export {
  RuntimeError,
  RuntimeUnsupportedError,
  RuntimeWorkspaceError,
  RuntimeBoundaryError,
  RuntimeFilesystemAccessDeniedError,
  RuntimeProtectedRootMutationError,
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
  RuntimeGitError,
  RuntimeAuthorizationError,
  RuntimeWorkspaceBoundaryMismatchError,
  RuntimeSandboxError,
  RuntimeSandboxProtocolError,
  RuntimePrivateTempError,
} from "./runtime-errors.js";
export type { RuntimeErrorCode } from "./runtime-errors.js";
export {
  LOCAL_RUNTIME_KIND,
  SingleRuntimeResolver,
  createLocalRuntimeResolver,
} from "./runtime-ref.js";
export type { RuntimeResolver } from "./runtime-ref.js";
export type { Runtime } from "./runtime.js";
export type { RuntimeWorkspaceOpenOptions } from "./runtime.js";
export type { RuntimeWorkspaceScope } from "./workspace-scope.js";
export {
  assertAuthorizedRuntimeExecution,
  assertRuntimeFilesystemBoundary,
  assertRuntimeWorkspaceBoundary,
  createRuntimeFilesystemPolicy,
  createAuthorizedRuntimeExecution,
  createRuntimeProcessPolicy,
} from "./security/runtime-boundary.js";
export type {
  AuthorizedRuntimeExecution,
  RuntimeFilesystemPolicy,
  RuntimeFilesystemPolicyInput,
  RuntimeProcessPolicy,
  RuntimeProcessPolicyInput,
} from "./security/runtime-boundary.js";
export {
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  MAX_SANDBOX_CONTROL_MESSAGE_BYTES,
  acceptSandboxMessage,
  acceptSandboxReady,
  acceptSandboxWorkspacePrepared,
  acceptSandboxWorkspaceStatus,
  createSandboxHello,
  decodeSandboxControlMessage,
  encodeSandboxControlMessage,
  validateSandboxControlMessage,
} from "./sandbox/control-protocol.js";
export {
  DEFAULT_SANDBOX_READY_TIMEOUT_MS,
  createSandboxControlTransport,
} from "./sandbox/control-transport.js";
export type { SandboxControlTransport } from "./sandbox/control-transport.js";
export type {
  SandboxControlMessage,
  SandboxErrorMessage,
  SandboxHelloMessage,
  SandboxReadyMessage,
  SandboxWorkspacePreparedMessage,
  SandboxWorkspaceStatusMessage,
} from "./sandbox/control-protocol.js";
export { selectProcessSandbox } from "./sandbox/provider-selection.js";
export { createUnrestrictedProcessSandboxProvider } from "./sandbox/unrestricted-provider.js";
export type {
  ProcessSandboxFactory,
  ProcessSandboxKind,
  ProcessSandboxProbe,
  ProcessSandboxProvider,
  SandboxProbeResult,
  SandboxedSpawnSpec,
  SandboxEnforcement,
} from "./sandbox/contracts.js";
export {
  createLinuxBubblewrapProvider,
  createLinuxLandlockProvider,
  LinuxBubblewrapProvider,
  LinuxLandlockProvider,
} from "./sandbox/linux-provider.js";
export type { LinuxSandboxProviderOptions } from "./sandbox/linux-provider.js";
export { createMacSeatbeltProvider, MacSeatbeltProvider } from "./sandbox/macos-provider.js";
export type { MacSeatbeltProviderOptions } from "./sandbox/macos-provider.js";
export {
  createWindowsAclRestrictedTokenProvider,
  WindowsAclRestrictedTokenProvider,
} from "./sandbox/windows-provider.js";
export type { WindowsAclRestrictedTokenProviderOptions } from "./sandbox/windows-provider.js";
export type {
  NativeRunnerProviderOptions,
  NativeSandboxRunnerManifest,
} from "./sandbox/native-runner-provider.js";
export {
  DEFAULT_SANDBOX_RUNNER_MANIFEST_FILENAME,
  POSIX_SANDBOX_RUNNER_EXECUTABLE,
  SANDBOX_RUNNER_MANIFEST_SCHEMA_VERSION,
  SANDBOX_RUNNER_PLATFORM_PROVIDERS,
  SandboxRunnerArtifactError,
  WINDOWS_SANDBOX_RUNNER_EXECUTABLE,
  defaultSandboxRunnerExecutableName,
  loadAndVerifySandboxRunnerArtifact,
  sandboxRunnerPlatformName,
  validateSandboxRunnerManifest,
} from "./sandbox/runner-artifact.js";
export type {
  LoadSandboxRunnerArtifactInput,
  ResolvedSandboxRunnerArtifact,
  SandboxRunnerArtifactReasonCode,
  SandboxRunnerManifest,
  SandboxRunnerPlatform,
} from "./sandbox/runner-artifact.js";
export { createNativeWorkspaceSandboxController } from "./sandbox/native-workspace-controller.js";
export type {
  NativeWorkspaceRunnerInvoker,
  NativeWorkspaceRunnerOperation,
  NativeWorkspaceRunnerResult,
  NativeWorkspaceSandboxController,
  NativeWorkspaceSandboxControllerOptions,
  NativeWorkspaceSandboxStatus,
} from "./sandbox/native-workspace-controller.js";
export {
  cleanupPrivateRunTemp,
  cleanupStalePrivateRunTemps,
  createPrivateRunTemp,
} from "./sandbox/private-temp.js";
export type { PrivateRunTemp, PrivateRunTempOptions } from "./sandbox/private-temp.js";
export {
  MAX_WORKSPACE_PATH_BYTES,
  WorkspacePathResolver,
  type ResolvedWorkspacePath,
  type ResolvedMutationPath,
  type ResolvedLexicalPath,
} from "./workspace-path.js";
export type {
  FilesystemTargetIndirection,
  FilesystemTargetRelation,
  ResolveFilesystemTargetInput,
  ResolvedFilesystemTarget,
  RuntimeFilesystemOperation,
} from "./workspace-path.js";
export type {
  RuntimeDirectoryEntry,
  RuntimeFileKind,
  RuntimeFileMetadata,
  RuntimeFileFingerprint,
  RuntimeFileSystem,
  RuntimeTextRead,
} from "./filesystem/types.js";
export { LocalRuntimeFileSystem } from "./filesystem/local-filesystem.js";
export {
  PolicyAwareRuntimeFileSystem,
  createPolicyAwarePatchMutationFileSystem,
} from "./filesystem/policy-aware-filesystem.js";
export { RuntimePatchError, RuntimePatchUncertainError } from "./patch/errors.js";
export type { RuntimePatchService } from "./patch/service.js";
export { parsePatch } from "./patch/parser.js";
export { inspectPatchTargets } from "./patch/inspection.js";
export type { PatchInspectionTarget } from "./patch/inspection.js";
export { PATCH_LIMITS } from "./patch/types.js";
export {
  applyPatchHunks,
  decodePatchText,
  encodeNewPatchFile,
  encodePatchedText,
} from "./patch/text.js";
export type {
  FileVersion,
  PatchChange,
  PatchDocument,
  PatchHunk,
  PatchLine,
  PatchLineKind,
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
export type { LocalRipgrepRunnerOptions } from "./search/ripgrep-runner.js";
export {
  LocalTextSearchFallback,
  MAX_FALLBACK_SEARCH_FILES,
  MAX_FALLBACK_SEARCH_FILE_BYTES,
  MAX_FALLBACK_SEARCH_MATCH_CHARS,
} from "./search/text-search-fallback.js";
export { parseRipgrepJson } from "./search/ripgrep-parser.js";
export * from "./exec/index.js";
export * from "./git/index.js";
