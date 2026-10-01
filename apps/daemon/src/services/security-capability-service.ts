import {
  SecurityCapabilitiesResponseSchema,
  SecurityPreparationResponseSchema,
  WorkspaceSecurityCapabilitiesResponseSchema,
  type PermissionPresetDescriptor,
  type PermissionPresetSelection,
  type SecurityCapabilitiesResponse,
  type SecurityPolicyPresetAvailability,
  type SecurityPreparationResponse,
  type WorkspaceSecurityCapabilitiesResponse,
  type WorkspaceId,
} from "@caelush/protocol";
import { getPermissionPresetCatalog, type PermissionPresetTemplate } from "@caelush/security";
import type {
  ProcessSandboxProvider,
  ProcessSandboxProbe,
  SandboxEnforcement,
} from "@caelush/runtime";

export interface WorkspacePreparationPort {
  readonly supported: boolean;
  getStatus(
    workspaceId: WorkspaceId,
    preset: PermissionPresetDescriptor,
  ): Promise<"NOT_REQUIRED" | "REQUIRED" | "READY" | "UNAVAILABLE">;
  prepare(
    workspaceId: WorkspaceId,
    preset: PermissionPresetSelection,
  ): Promise<Pick<SecurityPreparationResponse, "status" | "reasonCode">>;
}

export interface SecurityCapabilityServiceOptions {
  readonly catalog?: readonly PermissionPresetTemplate[];
  readonly processSandboxProviders?: readonly ProcessSandboxProvider[];
  readonly fullAccessAvailable?: boolean;
  readonly ttySupported?: boolean;
  readonly workspacePreparation?: WorkspacePreparationPort;
}

export interface RunSecurityRuntimeFacts {
  readonly runtimeKind: string;
  readonly sandboxProvider: string;
  readonly enforcement: SandboxEnforcement;
  readonly ttySupported: boolean;
}

const RESTRICTED_PRESET_IDS = new Set(["VIEW_ONLY", "WORKSPACE_WRITE"]);

/**
 * Host capability authority for the security selector.
 *
 * The service reports only verified provider probes. In particular, an unavailable restricted
 * provider is never represented as an ordinary-spawn fallback. Full Access is intentionally
 * represented by the explicit unrestricted adapter because that mode's product contract is host
 * user scope plus hard-safety checks, not a restricted sandbox.
 */
export class SecurityCapabilityService {
  private readonly catalog: readonly PermissionPresetDescriptor[];
  private readonly providers: readonly ProcessSandboxProvider[];
  private readonly fullAccessAvailable: boolean;
  private readonly ttySupported: boolean;
  private readonly workspacePreparation: WorkspacePreparationPort | undefined;
  private probesPromise: Promise<readonly ProcessSandboxProbe[]> | undefined;

  constructor(options: SecurityCapabilityServiceOptions = {}) {
    this.catalog = Object.freeze(
      [...(options.catalog ?? getPermissionPresetCatalog())].map((descriptor) =>
        Object.freeze({ ...descriptor }),
      ),
    );
    this.providers = Object.freeze([...(options.processSandboxProviders ?? [])]);
    this.fullAccessAvailable = options.fullAccessAvailable ?? true;
    this.ttySupported = options.ttySupported ?? false;
    this.workspacePreparation = options.workspacePreparation;
  }

  async getGlobalCapabilities(): Promise<SecurityCapabilitiesResponse> {
    const sandbox = await this.selectSandboxCapability();
    return SecurityCapabilitiesResponseSchema.parse({
      schemaVersion: 1,
      presets: this.catalog,
      defaultPreset: "WORKSPACE_WRITE",
      processSandbox: sandbox,
      ttySupported: this.ttySupported,
      workspacePreparationSupported: this.workspacePreparation?.supported ?? false,
    });
  }

  async getWorkspaceCapabilities(
    workspaceId: WorkspaceId,
  ): Promise<WorkspaceSecurityCapabilitiesResponse> {
    const sandbox = await this.selectSandboxCapability();
    const restrictedPresets = this.catalog.filter((preset) => RESTRICTED_PRESET_IDS.has(preset.id));
    const preparationStatuses = new Map<
      string,
      Awaited<ReturnType<WorkspacePreparationPort["getStatus"]>> | undefined
    >();
    await Promise.all(
      restrictedPresets.map(async (preset) => {
        preparationStatuses.set(
          preset.id,
          await this.workspacePreparation?.getStatus(workspaceId, preset),
        );
      }),
    );
    const availability = await Promise.all(
      this.catalog.map(async (preset): Promise<SecurityPolicyPresetAvailability> => {
        if (preset.id === "FULL_ACCESS") {
          return this.fullAccessAvailable
            ? { id: preset.id, version: preset.version, status: "AVAILABLE" }
            : {
                id: preset.id,
                version: preset.version,
                status: "UNAVAILABLE",
                reasonCode: "FULL_ACCESS_DISABLED",
              };
        }
        if (sandbox.status !== "AVAILABLE" || sandbox.enforcement === "NONE") {
          return {
            id: preset.id,
            version: preset.version,
            status: "UNAVAILABLE",
            reasonCode: sandbox.reasonCode ?? "RESTRICTED_SANDBOX_UNAVAILABLE",
          };
        }

        const preparation = preparationStatuses.get(preset.id);
        if (preparation === "REQUIRED") {
          return {
            id: preset.id,
            version: preset.version,
            status: "PREPARATION_REQUIRED",
            reasonCode: "WORKSPACE_PREPARATION_REQUIRED",
          };
        }
        if (preparation === "UNAVAILABLE") {
          return {
            id: preset.id,
            version: preset.version,
            status: "UNAVAILABLE",
            reasonCode: "WORKSPACE_PREPARATION_UNAVAILABLE",
          };
        }
        return { id: preset.id, version: preset.version, status: "AVAILABLE" };
      }),
    );
    const preparation = this.workspacePreparation?.supported
      ? [...preparationStatuses.values()].some((status) => status === "REQUIRED")
        ? {
            supported: true,
            status: "REQUIRED" as const,
            reasonCode: "WORKSPACE_PREPARATION_REQUIRED",
          }
        : [...preparationStatuses.values()].some((status) => status === "UNAVAILABLE")
          ? {
              supported: true,
              status: "UNAVAILABLE" as const,
              reasonCode: "WORKSPACE_PREPARATION_UNAVAILABLE",
            }
          : { supported: true, status: "READY" as const }
      : { supported: false, status: "NOT_REQUIRED" as const };

    return WorkspaceSecurityCapabilitiesResponseSchema.parse({
      schemaVersion: 1,
      workspaceId,
      presets: availability,
      preparation,
    });
  }

  async prepareWorkspace(
    workspaceId: WorkspaceId,
    selection: PermissionPresetSelection,
  ): Promise<SecurityPreparationResponse> {
    const preset = this.catalog.find((candidate) => candidate.id === selection.id);
    if (preset === undefined || preset.version !== selection.expectedVersion) {
      return {
        schemaVersion: 1,
        workspaceId,
        preset: selection,
        status: "FAILED",
        reasonCode: "PRESET_VERSION_MISMATCH",
      };
    }
    if (preset.id === "FULL_ACCESS" || this.workspacePreparation === undefined) {
      return {
        schemaVersion: 1,
        workspaceId,
        preset: selection,
        status: "UNAVAILABLE",
        reasonCode: "WORKSPACE_PREPARATION_UNSUPPORTED",
      };
    }
    const result = await this.workspacePreparation.prepare(workspaceId, selection);
    return SecurityPreparationResponseSchema.parse({
      schemaVersion: 1,
      workspaceId,
      preset: selection,
      ...result,
    });
  }

  async getRuntimeFacts(): Promise<RunSecurityRuntimeFacts> {
    const sandbox = await this.selectSandboxCapability();
    return {
      runtimeKind: "local",
      sandboxProvider: sandbox.provider,
      enforcement: sandbox.enforcement,
      ttySupported: this.ttySupported,
    };
  }

  private async selectSandboxCapability(): Promise<{
    readonly status: "AVAILABLE" | "UNAVAILABLE";
    readonly enforcement: SandboxEnforcement;
    readonly provider: string;
    readonly reasonCode?: string;
  }> {
    const probes = await this.probes();
    const available = probes
      .filter(
        (probe) =>
          probe.available &&
          probe.provider.kind === "RESTRICTED" &&
          probe.enforcement !== "NONE" &&
          probe.provider.enforcement !== "NONE",
      )
      .sort(
        (left, right) => enforcementRank(right.enforcement) - enforcementRank(left.enforcement),
      );
    const selected = available[0];
    if (selected !== undefined) {
      return {
        status: "AVAILABLE",
        enforcement: selected.enforcement,
        provider: selected.provider.id,
      };
    }
    if (this.fullAccessAvailable) {
      return { status: "AVAILABLE", enforcement: "NONE", provider: "unrestricted" };
    }
    const failed = probes.find((probe) => !probe.available && probe.reasonCode !== undefined);
    return {
      status: "UNAVAILABLE",
      enforcement: "NONE",
      provider: failed?.provider.id ?? "none",
      ...(failed?.reasonCode === undefined ? {} : { reasonCode: failed.reasonCode }),
    };
  }

  private async probes(): Promise<readonly ProcessSandboxProbe[]> {
    if (this.probesPromise !== undefined) return this.probesPromise;
    this.probesPromise = Promise.all(
      this.providers.map(async (provider): Promise<ProcessSandboxProbe> => {
        if (provider.probe === undefined) {
          return {
            provider,
            available: false,
            enforcement: "NONE",
            reasonCode: "PROBE_UNAVAILABLE",
          };
        }
        try {
          const result = await provider.probe();
          return { provider, ...result };
        } catch {
          return {
            provider,
            available: false,
            enforcement: "NONE",
            reasonCode: "PROBE_FAILED",
          };
        }
      }),
    );
    return this.probesPromise;
  }
}

function enforcementRank(value: SandboxEnforcement): number {
  return value === "HARD" ? 2 : value === "PARTIAL" ? 1 : 0;
}
