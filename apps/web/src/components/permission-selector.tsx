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
  const isPreparing = props.preparing !== undefined;
  const unavailablePresets = props.presets.filter((preset) => preset.status === "UNAVAILABLE");

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const preset = props.presets.find((item) => item.id === event.currentTarget.value);
    if (preset === undefined || preset.status === "UNAVAILABLE") return;
    const selection = {
      id: preset.id,
      expectedVersion: preset.version,
    } satisfies PermissionPresetSelection;
    if (preset.status === "PREPARATION_REQUIRED") {
      void props.onPrepare?.(selection);
      return;
    }
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
        disabled={props.disabled || isPreparing || props.presets.length === 0}
        onChange={handleChange}
        aria-label="选择权限"
        aria-busy={isPreparing ? "true" : undefined}
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
            className={
              preset.status === "PREPARATION_REQUIRED"
                ? "permission-selector-option--preparation-required"
                : undefined
            }
            disabled={preset.status === "UNAVAILABLE"}
          >
            {permissionPresetDisplayName(preset.id)}
            {preset.status === "UNAVAILABLE" ? "（不可用）" : ""}
          </option>
        ))}
      </select>
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
