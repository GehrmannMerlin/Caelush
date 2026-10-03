import type {
  ClientAgentRun,
  PermissionPresetSelection,
  SecurityCapabilitiesResponse,
  SelectablePermissionPresetId,
  WorkspaceSecurityCapabilitiesResponse,
} from "@caelush/protocol";

export const DEFAULT_PERMISSION_PRESET_ID: SelectablePermissionPresetId = "WORKSPACE_WRITE";

const PERMISSION_PRESET_DISPLAY_NAMES: Readonly<Record<SelectablePermissionPresetId, string>> =
  Object.freeze({
    VIEW_ONLY: "仅可查看",
    WORKSPACE_WRITE: "工作区内修改",
    FULL_ACCESS: "完全权限",
  });

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

export function permissionPresetDisplayName(id: SelectablePermissionPresetId): string {
  return PERMISSION_PRESET_DISPLAY_NAMES[id];
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
      displayName: permissionPresetDisplayName(descriptor.id),
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
  const autoSelectable = presets.filter(
    (preset) => preset.status === "AVAILABLE" && !preset.requiresConfirmation,
  );
  const preferredIds = [requestedId, DEFAULT_PERMISSION_PRESET_ID].filter(
    (id): id is SelectablePermissionPresetId => id !== undefined,
  );
  const candidate =
    preferredIds
      .map((id) => autoSelectable.find((preset) => preset.id === id))
      .find((preset) => preset !== undefined) ?? autoSelectable[0];
  if (candidate === undefined) return undefined;
  return { id: candidate.id, expectedVersion: candidate.version };
}

export function permissionPresetLabel(preset: PermissionPresetViewModel | undefined): string {
  return preset === undefined ? "未选择权限" : permissionPresetDisplayName(preset.id);
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

export function permissionPresetUnavailableReason(reasonCode: string | undefined): string {
  switch (reasonCode) {
    case "RUNNER_ARTIFACT_MISSING":
      return "未加载 Windows 安全组件，请重新启动 Caelush";
    case "RUNNER_HASH_MISMATCH":
    case "RUNNER_MANIFEST_INVALID":
      return "Windows 安全组件完整性校验失败";
    case "RUNNER_BACKEND_MISSING":
      return "Windows 安全组件后端缺失";
    case "RUNNER_FUNCTIONAL_PROBE_FAILED":
    case "PROBE_FAILED":
      return "Windows 安全组件自检失败";
    case "RUNNER_PLATFORM_UNSUPPORTED":
    case "UNSUPPORTED_PLATFORM":
      return "当前操作系统不支持受限权限";
    case "PROBE_UNAVAILABLE":
    case "RESTRICTED_SANDBOX_UNAVAILABLE":
      return "受限执行环境当前不可用";
    case "PERMISSION_PRESETS_DISABLED":
      return "权限预设功能已关闭";
    case "FULL_ACCESS_DISABLED":
    case "FULL_ACCESS_FEATURE_DISABLED":
      return "完全权限已关闭";
    case "RUNTIME_SANDBOX_DISABLED":
      return "受限执行功能当前已关闭";
    case "WORKSPACE_PREPARATION_UNAVAILABLE":
    case "WORKSPACE_PREPARATION_UNSUPPORTED":
      return "当前工作区无法完成安全准备";
    case "WORKSPACE_PREPARATION_NOT_CONFIRMED":
      return "主机未能确认工作区安全状态已更新";
    case "WORKSPACE_PREPARATION_RESPONSE_MISMATCH":
      return "主机返回的工作区或权限与请求不一致";
    case "WORKSPACE_NOT_FOUND":
      return "工作区不存在或路径无法访问";
    case "WINDOWS_PATH_BOUNDARY_INVALID":
      return "工作区路径无法安全识别或访问";
    case "WINDOWS_PATH_BOUNDARY_OVERLAP":
      return "工作区路径与另一个安全边界重叠";
    case "WINDOWS_PATH_BOUNDARY_REPARSE_UNSUPPORTED":
      return "工作区包含不支持的符号链接或重解析点";
    case "WINDOWS_PATH_BOUNDARY_IDENTITY_CHANGED":
      return "准备期间工作区目录身份发生变化，请重试";
    case "WINDOWS_PATH_BOUNDARY_ROOT_UNSUPPORTED":
      return "不能把磁盘根目录设为可写工作区";
    case "WINDOWS_WORKSPACE_CWD_BOUNDARY_INVALID":
      return "工作区启动目录超出安全边界";
    case "WINDOWS_ACL_READ_FAILED":
      return "无法读取工作区当前的 Windows 访问控制设置";
    case "WINDOWS_ACL_SID_FAILED":
      return "无法识别当前 Windows 用户的安全标识";
    case "WINDOWS_ACL_BUILD_FAILED":
      return "无法生成工作区安全权限设置";
    case "PRESET_VERSION_MISMATCH":
      return "权限预设版本已变化，请刷新后重试";
    case "WINDOWS_WORKSPACE_WRITE_OWNER_REQUIRED":
      return "当前用户缺少设置工作区安全权限所需的所有者权限";
    case "WINDOWS_ACL_APPLY_FAILED":
      return "Windows 未能应用工作区访问控制设置";
    case "WINDOWS_DACL_APPLY_FAILED":
      return "无法更新工作区目录访问控制列表";
    case "WINDOWS_INTEGRITY_LABEL_APPLY_FAILED":
      return "无法设置工作区完整性标签";
    case "WINDOWS_WORKSPACE_SECURITY_POSTCONDITION_FAILED":
      return "工作区安全状态校验未通过";
    case "WINDOWS_WORKSPACE_GRANT_MISSING":
      return "工作区安全权限未正确生效";
    case "WINDOWS_ACL_PATH_LOCK_FAILED":
      return "工作区权限正在被占用，暂时无法更新";
    default:
      return "当前主机无法提供此权限";
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
