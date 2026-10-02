import {
  createNativeWorkspaceSandboxController,
  createWindowsAclRestrictedTokenProvider,
  type NativeWorkspaceSandboxController,
  type ProcessSandboxProvider,
  type ResolvedSandboxRunnerArtifact,
} from "@caelush/runtime";
import type {
  PermissionPresetDescriptor,
  PermissionPresetSelection,
  WorkspaceId,
  WorkspaceRecord,
} from "@caelush/protocol";
import { StorageNotFoundError } from "@caelush/storage";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import type { WorkspacePreparationPort } from "./security-capability-service.js";

/**
 * The production Windows sandbox host adapter.
 *
 * ```text
 * resolveSandboxRunnerArtifact()   the verified artifact, resolved once at startup
 *        ↓
 * one NativeWorkspaceSandboxController   the Runtime's workspace ACL authority
 *        ├── one restricted Provider      createWindowsAclRestrictedTokenProvider
 *        └── one workspace preparation    WorkspacePreparationPort
 * ```
 *
 * This module is the only place the Daemon learns how a restricted Provider and a workspace
 * preparation port are built. No Win32 primitive, no Runner protocol frame and no token or ACL
 * detail enters the Daemon here: both values come from `@caelush/runtime` public entry points, which
 * is what keeps the Runtime the single process-execution substrate.
 *
 * The workspace root is never cached. Every status and every prepare resolves the workspace through
 * `WorkspaceService.requireWorkspace()` immediately before it touches the filesystem, so a removed
 * workspace, a re-registered ID or a path changed after registration can never prepare a stale
 * location.
 */

export const WINDOWS_SANDBOX_PROVIDER_ID = "windows-acl-restricted-token";

/** Bounded reason codes: an operator-readable fact, never a path, a Runner frame or a Win32 string. */
export const SANDBOX_RUNNER_UNAVAILABLE_REASON = "SANDBOX_RUNNER_UNAVAILABLE";
export const WORKSPACE_NOT_FOUND_REASON = "WORKSPACE_NOT_FOUND";
export const WORKSPACE_PREPARATION_UNAVAILABLE_REASON = "WORKSPACE_PREPARATION_UNAVAILABLE";

export interface WindowsSandboxHost {
  /** Exactly zero or one restricted Provider. Empty on a non-Windows host. */
  readonly providers: readonly ProcessSandboxProvider[];
  /** Exactly one preparation port; it reports `supported: false` when no Runner was packaged. */
  readonly workspacePreparation: WorkspacePreparationPort;
}

export interface WindowsSandboxHostOptions {
  readonly artifact: ResolvedSandboxRunnerArtifact | undefined;
  /** The workspace identity authority. Only `requireWorkspace` is used. */
  readonly workspaceService: Pick<WorkspaceService, "requireWorkspace">;
  readonly platform?: NodeJS.Platform;
  /** Host/test seam: build the one Runtime controller without touching a real Runner. */
  readonly createController?: (input: {
    readonly artifact: ResolvedSandboxRunnerArtifact | undefined;
  }) => NativeWorkspaceSandboxController;
  /** Host/test seam: build the one restricted Provider from the same controller. */
  readonly createProvider?: (input: {
    readonly artifact: ResolvedSandboxRunnerArtifact | undefined;
    readonly workspaceController: NativeWorkspaceSandboxController;
    readonly platform: NodeJS.Platform;
  }) => ProcessSandboxProvider;
}

export function createWindowsSandboxHost(options: WindowsSandboxHostOptions): WindowsSandboxHost {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return Object.freeze({
      providers: Object.freeze([] as readonly ProcessSandboxProvider[]),
      workspacePreparation: unsupportedWorkspacePreparation(),
    });
  }

  const artifact = options.artifact;
  const supported = artifact !== undefined;
  const workspaceController = (options.createController ?? defaultWorkspaceController)({
    artifact,
  });
  const provider = (options.createProvider ?? defaultRestrictedProvider)({
    artifact,
    workspaceController,
    platform,
  });

  return Object.freeze({
    providers: Object.freeze([provider]),
    workspacePreparation: Object.freeze(createWorkspacePreparation()),
  });

  function createWorkspacePreparation(): WorkspacePreparationPort {
    return {
      supported,
      async getStatus(workspaceId: WorkspaceId, preset: PermissionPresetDescriptor) {
        const workspace = await resolveWorkspace(options.workspaceService, workspaceId);
        if (workspace === undefined) return "UNAVAILABLE";
        const status = await workspaceController.getStatus(workspace.canonicalPath, preset.id);
        if (status === "READY") return "READY";
        if (status === "REQUIRED") return "REQUIRED";
        return "UNAVAILABLE";
      },
      async prepare(workspaceId: WorkspaceId, selection: PermissionPresetSelection) {
        if (!supported) {
          return { status: "UNAVAILABLE", reasonCode: SANDBOX_RUNNER_UNAVAILABLE_REASON };
        }
        const workspace = await resolveWorkspace(options.workspaceService, workspaceId);
        if (workspace === undefined) {
          return { status: "FAILED", reasonCode: WORKSPACE_NOT_FOUND_REASON };
        }
        const status = await workspaceController.prepare(workspace.canonicalPath, selection.id);
        return status === "READY"
          ? { status: "READY" }
          : { status: "UNAVAILABLE", reasonCode: WORKSPACE_PREPARATION_UNAVAILABLE_REASON };
      },
    };
  }
}

function defaultWorkspaceController(input: {
  readonly artifact: ResolvedSandboxRunnerArtifact | undefined;
}): NativeWorkspaceSandboxController {
  return createNativeWorkspaceSandboxController({
    providerId: WINDOWS_SANDBOX_PROVIDER_ID,
    ...(input.artifact === undefined ? {} : { runnerPath: input.artifact.runnerPath }),
  });
}

function defaultRestrictedProvider(input: {
  readonly artifact: ResolvedSandboxRunnerArtifact | undefined;
  readonly workspaceController: NativeWorkspaceSandboxController;
  readonly platform: NodeJS.Platform;
}): ProcessSandboxProvider {
  return createWindowsAclRestrictedTokenProvider({
    platform: input.platform,
    // The same controller the preparation port uses, so a private Run temp created per Run and the
    // ACL work that gates it are one Runtime object rather than two independent constructions.
    workspaceController: input.workspaceController,
    ...(input.artifact === undefined
      ? {}
      : {
          runnerPath: input.artifact.runnerPath,
          manifestPath: input.artifact.manifestPath,
          manifest: input.artifact.manifest,
        }),
  });
}

async function resolveWorkspace(
  workspaceService: Pick<WorkspaceService, "requireWorkspace">,
  workspaceId: WorkspaceId,
): Promise<WorkspaceRecord | undefined> {
  try {
    return await workspaceService.requireWorkspace(workspaceId);
  } catch (error) {
    if (error instanceof StorageNotFoundError) return undefined;
    throw error;
  }
}

function unsupportedWorkspacePreparation(): WorkspacePreparationPort {
  return Object.freeze({
    supported: false,
    async getStatus() {
      return "UNAVAILABLE" as const;
    },
    async prepare() {
      return { status: "UNAVAILABLE" as const, reasonCode: SANDBOX_RUNNER_UNAVAILABLE_REASON };
    },
  });
}
