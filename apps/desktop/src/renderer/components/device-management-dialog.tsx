import { useEffect, useRef, type MouseEvent, type ReactElement } from "react";
import { LaptopMinimal, X } from "lucide-react";
import type { AccountState, SafeDevice } from "../../main/account/state.js";

interface DeviceManagementPanelProps {
  readonly state: AccountState;
  readonly devices: readonly SafeDevice[];
  readonly loading: boolean;
  readonly online: boolean;
  readonly busy: boolean;
  onRevoke(device: SafeDevice): void;
}

export function DeviceManagementPanel(props: DeviceManagementPanelProps): ReactElement {
  const currentDevice = props.devices.find((device) => device.current) ?? props.state.device;
  const currentDeviceCanBeRevoked =
    currentDevice !== undefined &&
    props.devices.some((device) => device.deviceId === currentDevice.deviceId && !device.revokedAt);
  const otherDevices = props.devices.filter((device) => !device.current && !device.revokedAt);

  return (
    <section className="detail-panel device-summary">
      <div className="panel-heading">
        <h3>Windows 桌面端</h3>
        <LaptopMinimal size={18} />
      </div>
      <div className="device-name">
        <div className="device-tile">
          <LaptopMinimal size={19} />
        </div>
        <div>
          <b>{formatDeviceLabel(currentDevice?.label ?? "Caelush Desktop")}</b>
          <span>{currentDevice ? "当前设备" : "设备尚未验证"}</span>
        </div>
      </div>
      <div className="detail-row">
        <span>设备 ID</span>
        <b className="mono-value">{currentDevice?.deviceId ?? "—"}</b>
      </div>
      {currentDeviceCanBeRevoked && currentDevice && (
        <button
          type="button"
          className="revoke-button device-current-revoke"
          disabled={!props.online || props.busy}
          onClick={() => props.onRevoke(currentDevice)}
        >
          撤销此设备
        </button>
      )}
      <div className="device-list-heading">其他授权设备</div>
      {!props.online ? (
        <p className="device-list-message">连接云端后可查看完整设备记录并撤销授权。</p>
      ) : props.loading ? (
        <DeviceRowsSkeleton />
      ) : otherDevices.length === 0 ? (
        <p className="device-list-message">暂无其他设备记录。</p>
      ) : (
        <div className="device-list">
          {otherDevices.map((device) => (
            <div className="device-row" key={device.deviceId}>
              <div className="device-tile">
                <LaptopMinimal size={18} />
              </div>
              <div className="device-row-main">
                <b>{formatDeviceLabel(device.label)}</b>
                <span>
                  设备 ID：{device.deviceId} · 最近活动：
                  {device.lastSeenAt ? formatDate(device.lastSeenAt) : "暂无记录"}
                </span>
              </div>
              <div className="device-row-status">
                <span className="status-dot" />
                已授权
              </div>
              <button
                type="button"
                className="revoke-button"
                disabled={props.busy}
                onClick={() => props.onRevoke(device)}
              >
                撤销
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function DeviceManagementDialog(props: {
  readonly state: AccountState;
  readonly devices: readonly SafeDevice[];
  readonly loading: boolean;
  readonly online: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  onClose(): void;
  onRevoke(device: SafeDevice): void;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key === "Tab") {
        const controls = [
          ...(root.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href],[tabindex="0"]',
          ) ?? []),
        ];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !props.busy) props.onClose();
  }

  return (
    <div className="device-management-backdrop" onClick={closeFromBackdrop}>
      <section
        className="device-management-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-management-title"
        ref={root}
      >
        <header className="device-management-dialog-header">
          <div>
            <h2 id="device-management-title">登录设备</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="icon-button device-management-close"
            aria-label="关闭设备管理"
            disabled={props.busy}
            onClick={props.onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="device-management-dialog-body">
          {props.error && (
            <p className="device-management-error" role="alert">
              {props.error}
            </p>
          )}
          <DeviceManagementPanel
            state={props.state}
            devices={props.devices}
            loading={props.loading}
            online={props.online}
            busy={props.busy}
            onRevoke={props.onRevoke}
          />
        </div>
      </section>
    </div>
  );
}

export function DeviceRowsSkeleton(): ReactElement {
  return (
    <div className="device-list account-skeleton-device-list" aria-hidden="true">
      {[0, 1].map((row) => (
        <div className="device-row account-skeleton-device-row" key={row}>
          <span className="skeleton-block account-skeleton-device-icon" />
          <div className="account-skeleton-device-copy">
            <span className="skeleton-block account-skeleton-value" />
            <span className="skeleton-block account-skeleton-copy" />
          </div>
          <span className="skeleton-block account-skeleton-device-status" />
          <span className="skeleton-block account-skeleton-button-small" />
        </div>
      ))}
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatDeviceLabel(label: string): string {
  if (label === "Caelush Desktop") return "Caelush 桌面端";
  if (label === "Windows desktop") return "Windows 桌面端";
  return label;
}
