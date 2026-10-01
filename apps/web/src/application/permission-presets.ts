import type {
  ClientAgentRun,
  PermissionPresetSelection,
  SecurityCapabilitiesResponse,
  SelectablePermissionPresetId,
  WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";

export const DEFAULT_PERMISSION_PRESET_ID: SelectablePermissionPresetId = "WORKSPACE_WRITE";

export type PermissionPresetAvailability = "AVAILABLE" | "PREPARATION_REQUIRED" | "UNAVAILABLE";

export interface PermissionPresetViewModel {
  readonly id: SelectablePermissionPresetId;
  readonly version: number;
  readonly displayName: string;
  readonly description: string;
  readonly status: PermissionPresetAvailability;
  readonly reasonCode?: string;
  readonly requiresConfirmation: boolean;
  readonly sandboxEnforcement: "HARD" | "PARTIAL" | "NONE";
}

export function projectPermissionPresetViewModels(
  capabilities: SecurityCapabilitiesResponse,
  workspaceCapabilities: WorkspaceSecurityCapabilitiesResponse,
): readonly PermissionPresetViewModel[] {
  const statuses = new Map(workspaceCapabilities.presets.map((preset) => [preset.id, preset]));
  return capabilities.presets.map((descriptor) => {
    const availability = statuses.get(descriptor.id);
    return Object.freeze({
      id: descriptor.id,
      version: descriptor.version,
      displayName: descriptor.displayName,
      description: descriptor.description,
      status: availability?.status ?? "UNAVAILABLE",
      ...(availability?.reasonCode === undefined ? {} : { reasonCode: availability.reasonCode }),
      requiresConfirmation: descriptor.requiresConfirmation,
      sandboxEnforcement:
        descriptor.id === "FULL_ACCESS" ? "NONE" : capabilities.processSandbox.enforcement,
    });
  });
}

export function choosePermissionPreset(
  presets: readonly PermissionPresetViewModel[],
  requestedId?: SelectablePermissionPresetId,
): PermissionPresetSelection | undefined {
  const candidate = presets.find(
    (preset) => preset.id === (requestedId ?? DEFAULT_PERMISSION_PRESET_ID),
  );
  if (candidate === undefined || candidate.status !== "AVAILABLE") return undefined;
  return { id: candidate.id, expectedVersion: candidate.version };
}

export function permissionPresetLabel(preset: PermissionPresetViewModel | undefined): string {
  return preset?.displayName ?? "未选择权限";
}

export function permissionPresetStatusLabel(preset: PermissionPresetViewModel): string {
  switch (preset.status) {
    case "AVAILABLE":
      return preset.sandboxEnforcement === "HARD"
        ? "已启用 · 完整受限执行"
        : preset.sandboxEnforcement === "PARTIAL"
          ? "已启用 · 部分受限执行"
          : "已启用 · 硬安全规则";
    case "PREPARATION_REQUIRED":
      return "需要准备工作区";
    case "UNAVAILABLE":
      return "当前不可用";
  }
}

export function fullAccessConfirmationCopy(): readonly string[] {
  return [
    "完全权限会让 Agent 使用主机用户范围执行文件、进程和网络操作。",
    "硬安全规则仍然有效；权限不足的动作会被拒绝，不会自动批准。",
    "不透明的第三方二进制仍可能隐藏文件读取或网络外传。",
  ];
}

export function runPermissionPreset(
  run: Pick<ClientAgentRun, "securityPolicy"> | undefined,
): PermissionPresetSelection | undefined {
  const preset = run?.securityPolicy?.preset;
  return preset === undefined || preset.id === "LEGACY_CUSTOM"
    ? undefined
    : { id: preset.id, expectedVersion: preset.version };
}
