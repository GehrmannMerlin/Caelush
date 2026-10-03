import { useState, type ChangeEvent, type ReactElement } from "react";
import type { PermissionPresetSelection } from "@caelush/protocol";
import {
  fullAccessConfirmationCopy,
  permissionPresetDisplayName,
  permissionPresetUnavailableReason,
  type PermissionPresetViewModel,
} from "../application/permission-presets.js";

export interface PermissionSelectorProps {
  readonly presets: readonly PermissionPresetViewModel[];
  /** User intent; it can be waiting for preparation while a safer preset remains effective. */
  readonly selected?: PermissionPresetSelection | undefined;
  readonly active?: PermissionPresetSelection | undefined;
  readonly preparing?: PermissionPresetSelection | undefined;
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly confirmationOpen?: boolean;
  readonly onSelect: (selection: PermissionPresetSelection) => void;
  readonly onPrepare?: (selection: PermissionPresetSelection) => Promise<boolean> | void;
}

export function PermissionSelector(props: PermissionSelectorProps): ReactElement {
  const initialConfirmation =
    props.confirmationOpen === true && props.selected?.id === "FULL_ACCESS"
      ? props.selected
      : undefined;
  const [pendingConfirmation, setPendingConfirmation] = useState<
    PermissionPresetSelection | undefined
  >(initialConfirmation);
  const selectedValue = props.selected?.id ?? "";
  const unavailablePresets = props.presets.filter((preset) => preset.status === "UNAVAILABLE");
  const effectivePermissionStatus = `当前实际用于新任务：${
    props.active === undefined
      ? "未选择（无法创建任务）"
      : permissionPresetDisplayName(props.active.id)
  }${
    props.selected !== undefined && props.selected.id !== props.active?.id
      ? `；请求的${permissionPresetDisplayName(props.selected.id)}尚未生效`
      : ""
  }`;

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const preset = props.presets.find((item) => item.id === event.currentTarget.value);
    if (preset === undefined || preset.status !== "AVAILABLE") return;
    const selection = {
      id: preset.id,
      expectedVersion: preset.version,
    } satisfies PermissionPresetSelection;
    if (preset.requiresConfirmation) {
      setPendingConfirmation(selection);
      return;
    }
    props.onSelect(selection);
  };

  const confirmFullAccess = () => {
    if (pendingConfirmation === undefined) return;
    props.onSelect(pendingConfirmation);
    setPendingConfirmation(undefined);
  };

  return (
    <div className="permission-selector">
      <select
        id="permission-preset-select"
        className="permission-selector-select"
        value={selectedValue}
        disabled={props.disabled || props.presets.length === 0}
        onChange={handleChange}
        aria-label="选择权限"
        data-empty={selectedValue === "" ? "true" : undefined}
      >
        {props.presets.length === 0 ? (
          <option value="">权限能力不可用</option>
        ) : selectedValue === "" ? (
          <option value="">请选择权限</option>
        ) : null}
        {props.presets.map((preset) => (
          <option
            key={`${preset.id}@${preset.version}`}
            value={preset.id}
            disabled={preset.status !== "AVAILABLE"}
          >
            {permissionPresetDisplayName(preset.id)}
            {preset.status === "UNAVAILABLE" ? "（不可用）" : ""}
            {preset.status === "PREPARATION_REQUIRED" ? "（待准备）" : ""}
          </option>
        ))}
      </select>
      <p
        className="permission-selector-effective"
        role="status"
        aria-live="polite"
        title={effectivePermissionStatus}
      >
        {effectivePermissionStatus}
      </p>
      {unavailablePresets.length === 0 ? null : (
        <p className="permission-selector-notice" role="status">
          {unavailablePresets
            .map(
              (preset) =>
                `${permissionPresetDisplayName(preset.id)}不可用：${permissionPresetUnavailableReason(preset.reasonCode)}`,
            )
            .join("；")}
          。
        </p>
      )}
      {props.presets
        .filter((preset) => preset.status === "PREPARATION_REQUIRED")
        .map((preset) => (
          <button
            key={`prepare-${preset.id}`}
            type="button"
            className="permission-selector-prepare"
            disabled={
              props.disabled ||
              props.onPrepare === undefined ||
              (props.preparing?.id === preset.id &&
                props.preparing.expectedVersion === preset.version)
            }
            onClick={() =>
              void props.onPrepare?.({ id: preset.id, expectedVersion: preset.version })
            }
          >
            {props.preparing?.id === preset.id && props.preparing.expectedVersion === preset.version
              ? "准备中…"
              : `准备${permissionPresetDisplayName(preset.id)}`}
          </button>
        ))}
      {props.error === undefined ? null : (
        <p className="permission-selector-error" role="alert">
          {props.error}
        </p>
      )}
      {pendingConfirmation === undefined ? null : (
        <div className="permission-selector-confirmation" role="dialog" aria-modal="true">
          <h2>确认完全权限</h2>
          {fullAccessConfirmationCopy().map((line) => (
            <p key={line}>{line}</p>
          ))}
          <div className="permission-selector-confirmation-actions">
            <button type="button" onClick={() => setPendingConfirmation(undefined)}>
              取消
            </button>
            <button type="button" onClick={confirmFullAccess}>
              确认使用完全权限
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
