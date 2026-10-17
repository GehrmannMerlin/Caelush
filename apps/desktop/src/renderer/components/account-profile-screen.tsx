import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  LoaderCircle,
  LogOut,
  Pencil,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { AccountEntitlement } from "../../main/cloud/schemas.js";
import type { DesktopAccountProfile } from "../../main/account/state.js";
import type { AccountProfileUpdateInput } from "../../main/cloud/schemas.js";
import type { AccountCenterSnapshot } from "../../main/profile-center/contract.js";
import type { DesktopModelSettingsSnapshot } from "../../main/profile-center/contract.js";
import type { DesktopProfileCenterApi } from "../../preload/api-types.js";
import { SettingsSurface } from "@caelush/ui-theme";

type AvatarMimeType = "image/png" | "image/jpeg" | "image/webp";
type CropRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};
type AvatarSelection = {
  readonly bytes: Uint8Array;
  readonly mimeType: AvatarMimeType;
  readonly crop: CropRect;
};

interface Props {
  readonly profile: DesktopAccountProfile | null;
  readonly loading: boolean;
  readonly online: boolean;
  readonly busy: boolean;
  readonly loadError: string | null;
  readonly entitlements: readonly AccountEntitlement[];
  readonly profileCenterApi?: DesktopProfileCenterApi | undefined;
  onOpenSession(sessionId: string): void;
  onOpenWorkbench(): void;
  onManageDevices(): void;
  onLogout(): void;
  onSelectAvatar(): Promise<{
    readonly mimeType: AvatarMimeType;
    readonly bytes: Uint8Array;
  } | null>;
  onSave(input: AccountProfileUpdateInput): Promise<DesktopAccountProfile>;
}

export function AccountProfileScreen(props: Props) {
  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [selection, setSelection] = useState<AvatarSelection | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [cropSource, setCropSource] = useState<{
    readonly bytes: Uint8Array;
    readonly mimeType: AvatarMimeType;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [centerSnapshot, setCenterSnapshot] = useState<AccountCenterSnapshot | null>(null);
  const [centerLoading, setCenterLoading] = useState(false);
  const [centerError, setCenterError] = useState<string | null>(null);
  const [centerReloadToken, setCenterReloadToken] = useState(0);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [modelSettings, setModelSettings] = useState<DesktopModelSettingsSnapshot | null>(null);
  const [modelSettingsLoading, setModelSettingsLoading] = useState(false);
  const [modelSettingsError, setModelSettingsError] = useState<string | undefined>();
  const skipNameBlur = useRef(false);
  const imageUrl = useMemo(() => {
    if (props.profile?.avatarBytes === null || props.profile === null) return null;
    return bytesToDataUrl(props.profile.avatarBytes, "image/webp");
  }, [props.profile?.avatarBytes, props.profile]);

  useEffect(() => {
    if (props.profile === null || dirty) return;
    setDisplayName(props.profile.displayName);
  }, [props.profile, dirty]);

  useEffect(() => {
    if (selection === null) {
      setPreviewUrl(null);
      return;
    }
    let active = true;
    void createCropPreview(selection.bytes, selection.mimeType, selection.crop)
      .then((url) => {
        if (active) setPreviewUrl(url);
      })
      .catch(() => setPreviewUrl(null));
    return () => {
      active = false;
    };
  }, [selection]);

  useEffect(() => {
    const api = props.profileCenterApi;
    if (api === undefined) {
      setCenterSnapshot(null);
      setCenterError("当前版本暂不支持读取最近工作与用量。");
      return undefined;
    }
    let active = true;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    setCenterLoading(true);
    setCenterError(null);
    void api
      .getSnapshot({ sinceMs: monthStart, timezoneOffsetMinutes: -now.getTimezoneOffset() })
      .then((snapshot) => {
        if (active) setCenterSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        if (active)
          setCenterError(error instanceof Error ? error.message : "无法读取最近工作与用量。");
      })
      .finally(() => {
        if (active) setCenterLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.profileCenterApi, centerReloadToken]);

  const loadModelSettings = useCallback(async () => {
    const api = props.profileCenterApi;
    if (api === undefined) {
      setModelSettingsError("当前版本暂不支持模型配置。");
      setModelSettingsLoading(false);
      return;
    }
    setModelSettingsLoading(true);
    setModelSettingsError(undefined);
    try {
      setModelSettings(await api.getModelSettings());
    } catch (error) {
      setModelSettingsError(
        error instanceof Error ? error.message : "无法读取模型配置，请稍后重试。",
      );
    } finally {
      setModelSettingsLoading(false);
    }
  }, [props.profileCenterApi]);

  const connectModelProvider = async (providerId: string, apiKey: string) => {
    const api = props.profileCenterApi;
    if (api === undefined) return { ok: false, message: "模型配置功能暂不可用。" } as const;
    try {
      const result = await api.connectProvider({ providerId, apiKey });
      if (result.ok) await loadModelSettings();
      return result;
    } catch {
      return { ok: false, message: "Provider 连接失败，请稍后重试。" } as const;
    }
  };

  const disconnectModelProvider = async (providerId: string): Promise<boolean> => {
    const api = props.profileCenterApi;
    if (api === undefined) return false;
    try {
      const disconnected = await api.disconnectProvider({ providerId });
      if (disconnected) await loadModelSettings();
      return disconnected;
    } catch {
      return false;
    }
  };

  const visibleAvatarUrl = selection !== null ? previewUrl : removeAvatar ? null : imageUrl;
  const canEdit = props.online && props.profile?.canEdit === true && !saving && !props.busy;

  const save = async (input: AccountProfileUpdateInput): Promise<boolean> => {
    setSaving(true);
    setMessage(null);
    try {
      const updated = await props.onSave(input);
      setDisplayName(updated.displayName);
      setSelection(null);
      setRemoveAvatar(false);
      setDirty(false);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法保存个人信息。");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const chooseAvatar = async () => {
    setChoosing(true);
    setMessage(null);
    try {
      const selected = await props.onSelectAvatar();
      if (selected !== null) setCropSource(selected);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法读取所选图片。");
    } finally {
      setChoosing(false);
    }
  };

  const saveDisplayName = async () => {
    if (skipNameBlur.current) {
      skipNameBlur.current = false;
      return;
    }
    setEditingName(false);
    if (!canEdit) {
      setDisplayName(props.profile?.displayName ?? "");
      setDirty(false);
      return;
    }
    const normalizedName = displayName.normalize("NFC").trim();
    const nameLength = Array.from(normalizedName).length;
    if (nameLength < 1 || nameLength > 32 || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(normalizedName)) {
      setDisplayName(props.profile?.displayName ?? "");
      setDirty(false);
      setMessage("展示名需为 1–32 个字符，且不能包含控制字符。");
      return;
    }
    if (normalizedName === props.profile?.displayName) {
      setDisplayName(normalizedName);
      setDirty(false);
      return;
    }
    await save({ displayName: normalizedName, removeAvatar: false });
  };

  const clearAvatar = async () => {
    if (props.profile === null) return;
    setRemoveAvatar(true);
    setSelection(null);
    setDirty(true);
    const saved = await save({
      displayName: props.profile.displayName,
      removeAvatar: true,
    });
    if (!saved) {
      setRemoveAvatar(false);
      setDirty(false);
    }
  };

  const acceptCrop = (crop: CropRect) => {
    if (cropSource === null) return;
    const nextSelection = { ...cropSource, crop };
    setSelection(nextSelection);
    setCropSource(null);
    setRemoveAvatar(false);
    setDirty(true);
    void save({
      displayName: displayName.normalize("NFC").trim(),
      removeAvatar: false,
      avatar: {
        bytes: new Uint8Array(nextSelection.bytes) as Uint8Array<ArrayBuffer>,
        contentType: nextSelection.mimeType,
        crop: nextSelection.crop,
      },
    });
  };

  return (
    <div className="account-profile-stack">
      <section className="profile-card" aria-label="个人信息">
        {(!props.online || props.profile?.canEdit === false) && (
          <div className="account-profile-banner" role="status">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>
              {props.online
                ? "Cloud 暂时不可达，当前显示缓存资料。重新连接后即可编辑。"
                : "当前离线，显示本机缓存资料。重新连接后即可编辑。"}
            </span>
          </div>
        )}
        {props.loading && <p className="account-profile-feedback">正在读取个人信息…</p>}
        {!props.loading && props.loadError !== null && (
          <p className="account-profile-feedback is-error" role="alert">
            {props.loadError}
          </p>
        )}
        {props.profile !== null && (
          <div className="profile-edit-form">
            <div className="profile-avatar-row">
              <div className="profile-avatar-frame">
                {visibleAvatarUrl !== null ? (
                  <img src={visibleAvatarUrl} alt={`${props.profile.displayName}的头像`} />
                ) : (
                  <span>{avatarFallback(displayName || props.profile.displayName)}</span>
                )}
                <div className="profile-avatar-overlay" role="group" aria-label="头像操作">
                  <button
                    className="profile-avatar-action"
                    type="button"
                    aria-label="上传头像"
                    title="上传头像"
                    disabled={!canEdit || choosing}
                    onClick={() => void chooseAvatar()}
                  >
                    {choosing || (saving && selection !== null) ? (
                      <LoaderCircle size={17} className="spin" aria-hidden="true" />
                    ) : (
                      <Upload size={17} aria-hidden="true" />
                    )}
                  </button>
                  {(props.profile.avatarRevision !== null || selection !== null) && (
                    <button
                      className="profile-avatar-action is-danger"
                      type="button"
                      aria-label="删除头像"
                      title="删除头像"
                      disabled={!canEdit}
                      onClick={() => void clearAvatar()}
                    >
                      <Trash2 size={17} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {editingName ? (
              <input
                id="profile-display-name"
                className="profile-name-input"
                aria-label="展示名"
                autoComplete="nickname"
                maxLength={64}
                value={displayName}
                disabled={!canEdit}
                autoFocus
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  setDirty(true);
                  setMessage(null);
                }}
                onBlur={() => void saveDisplayName()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    skipNameBlur.current = true;
                    setDisplayName(props.profile?.displayName ?? "");
                    setDirty(false);
                    setEditingName(false);
                    setMessage(null);
                    window.setTimeout(() => {
                      skipNameBlur.current = false;
                    }, 0);
                  }
                }}
              />
            ) : (
              <button
                className="profile-name-button"
                type="button"
                disabled={!canEdit}
                aria-label={`编辑展示名：${displayName}`}
                title={canEdit ? "点击编辑展示名" : undefined}
                onClick={() => {
                  setMessage(null);
                  setEditingName(true);
                }}
              >
                <span>{displayName}</span>
                {canEdit && <Pencil size={15} aria-hidden="true" />}
              </button>
            )}
            <p className="profile-email">{props.profile.email}</p>
            {saving && (
              <p className="account-profile-feedback" role="status">
                <LoaderCircle size={13} className="spin" aria-hidden="true" /> 正在保存…
              </p>
            )}
            {message !== null && !props.loading && (
              <p className="account-profile-feedback is-error" role="alert">
                {message}
              </p>
            )}
          </div>
        )}
      </section>

      <div className="account-center-sections">
        <section className="account-center-section" aria-labelledby="profile-recent-work-heading">
          <div className="account-center-heading">
            <h3 id="profile-recent-work-heading">最近工作</h3>
            <button
              className="account-center-heading-action"
              type="button"
              onClick={props.onOpenWorkbench}
            >
              进入工作台 <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          </div>
          {centerLoading && centerSnapshot === null ? (
            <p className="account-center-message" role="status">
              正在读取最近会话…
            </p>
          ) : centerSnapshot?.recentSessions.length ? (
            <div className="account-center-session-list">
              {centerSnapshot.recentSessions.map((session) => (
                <button
                  className="account-center-session"
                  key={session.id}
                  type="button"
                  aria-label={`继续会话：${session.title}`}
                  onClick={() => props.onOpenSession(session.id)}
                >
                  <span className="account-center-session-copy">
                    <b>{session.title}</b>
                    <small>{formatSessionDate(session.updatedAt)}</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : centerError !== null ? (
            <div className="account-center-empty">
              <p className="account-center-message is-error" role="alert">
                {centerError}
              </p>
              <button
                className="account-center-inline-action"
                type="button"
                onClick={() => setCenterReloadToken((value) => value + 1)}
              >
                重试
              </button>
            </div>
          ) : (
            <p className="account-center-message">完成一次工作后，最近会话会显示在这里。</p>
          )}
        </section>

        <section className="account-center-section" aria-labelledby="profile-usage-heading">
          <div className="account-center-heading">
            <h3 id="profile-usage-heading">模型与用量</h3>
          </div>
          {centerSnapshot !== null && (
            <div className="account-center-usage-summary" aria-label="模型调用用量">
              <UsageMetric
                label="本月成功请求"
                value={formatUsageCount(centerSnapshot.usage.since.successfulRequests)}
              />
              <UsageMetric
                label="本月 Token"
                value={formatUsageTokens(centerSnapshot.usage.since)}
              />
              <UsageMetric
                label="累计 Token"
                value={formatUsageTokens(centerSnapshot.usage.allTime)}
              />
            </div>
          )}
          {centerSnapshot !== null && <UsageActivityChart days={centerSnapshot.activity} />}
          <button
            className="account-center-row is-action"
            type="button"
            onClick={() => {
              setModelSettings(null);
              setModelSettingsOpen(true);
              void loadModelSettings();
            }}
          >
            <span className="account-center-row-copy">
              <span>模型与 API Key</span>
            </span>
            <span className="account-center-row-action">
              管理模型 <ChevronRight size={15} aria-hidden="true" />
            </span>
          </button>
        </section>

        <section className="account-center-section" aria-labelledby="profile-account-heading">
          <div className="account-center-heading">
            <h3 id="profile-account-heading">账号管理</h3>
          </div>
          <div className="account-center-row">
            <span className="account-center-row-copy">
              <b>桌面版权益</b>
              <small>Caelush Desktop</small>
            </span>
            <span
              className={`account-center-entitlement ${hasDesktopEntitlement(props.entitlements) ? "is-enabled" : ""}`}
            >
              {hasDesktopEntitlement(props.entitlements) ? (
                <>
                  <Check size={14} aria-hidden="true" /> 已启用
                </>
              ) : (
                "未启用"
              )}
            </span>
          </div>
          <button
            className="account-center-row is-action"
            type="button"
            onClick={props.onManageDevices}
          >
            <span className="account-center-row-copy">
              <span>登录设备</span>
            </span>
            <span className="account-center-row-action">
              管理设备 <ChevronRight size={15} aria-hidden="true" />
            </span>
          </button>
          <button
            className="account-center-row is-action is-danger"
            type="button"
            disabled={props.busy}
            onClick={props.onLogout}
          >
            <span className="account-center-row-copy">
              <span>切换账户</span>
            </span>
            <span className="account-center-row-action">
              <LogOut size={14} aria-hidden="true" /> 退出登录
            </span>
          </button>
        </section>
      </div>

      {cropSource !== null && (
        <AvatarCropDialog
          bytes={cropSource.bytes}
          mimeType={cropSource.mimeType}
          onCancel={() => setCropSource(null)}
          onConfirm={acceptCrop}
        />
      )}
      {modelSettingsOpen && (
        <SettingsSurface
          providers={modelSettings?.providers ?? []}
          models={modelSettings?.models ?? []}
          loading={modelSettingsLoading}
          loadError={modelSettingsError}
          onRetry={() => void loadModelSettings()}
          onClose={() => setModelSettingsOpen(false)}
          onConnect={connectModelProvider}
          onDisconnect={disconnectModelProvider}
        />
      )}
    </div>
  );
}

function UsageMetric(props: { label: string; value: string }) {
  return (
    <div className="account-center-usage-metric">
      <b>{props.value}</b>
      <span>{props.label}</span>
    </div>
  );
}

function UsageActivityChart(props: { days: AccountCenterSnapshot["activity"] }) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayCount = Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1;
  const startWeekday = start.getDay();
  const usageByDay = new Map((props.days ?? []).map((day) => [day.date, day]));
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return {
      date: key,
      value: date,
      usage: usageByDay.get(key),
      week: Math.floor((startWeekday + index) / 7),
      weekday: (startWeekday + index) % 7,
    };
  });
  const intensityValues = days.map(({ usage }) =>
    usage === undefined ? 0 : (usage.totalTokens ?? usage.successfulRequests),
  );
  const maxUsage = Math.max(1, ...intensityValues);
  const chartWidth = 744;
  const cellSize = 10;
  const cellStep = 13;
  const monthFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric" });

  return (
    <section className="account-center-activity" aria-labelledby="profile-activity-heading">
      <div className="account-center-activity-heading">
        <h4 id="profile-activity-heading">近 12 个月 Token 活动</h4>
        <span>少</span>
        <span className="account-center-activity-legend" aria-hidden="true">
          <i data-level="1" />
          <i data-level="2" />
          <i data-level="3" />
          <i data-level="4" />
        </span>
        <span>多</span>
      </div>
      <svg
        className="account-center-activity-chart"
        viewBox={`0 0 ${chartWidth} 120`}
        role="img"
        aria-label={`近 12 个月每日 Token 活动，共 ${dayCount} 天`}
        preserveAspectRatio="none"
      >
        {days
          .filter(({ value }) => value.getDate() === 1)
          .map(({ date, value, week }) => (
            <text key={`month-${date}`} x={week * cellStep + 2} y="11">
              {monthFormatter.format(value)}
            </text>
          ))}
        {days.map(({ date, week, weekday, usage }, index) => {
          const amount = intensityValues[index] ?? 0;
          const level =
            amount === 0
              ? 0
              : Math.max(1, Math.ceil((Math.log1p(amount) / Math.log1p(maxUsage)) * 4));
          const x = week * cellStep + 2;
          const y = 19 + weekday * cellStep;
          const tokenLabel =
            usage === undefined
              ? "0 Token"
              : usage.totalTokens === null
                ? "Token 未完整上报"
                : `${formatUsageCount(usage.totalTokens)} Token`;
          return (
            <g key={`day-${date}`}>
              <rect
                className={usage?.totalTokens === null ? "is-unmetered" : ""}
                data-level={level}
                x={x}
                y={y}
                width={cellSize}
                height={cellSize}
                rx="2.5"
              >
                <title>{`${date} · ${tokenLabel} · ${formatUsageCount(usage?.successfulRequests ?? 0)} 次成功请求`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </section>
  );
}

function AvatarCropDialog(props: {
  readonly bytes: Uint8Array;
  readonly mimeType: AvatarMimeType;
  onCancel(): void;
  onConfirm(crop: CropRect): void;
}) {
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [zoom, setZoom] = useState(1);
  const updateCrop = useCallback((value: CropRect) => setCrop(value), []);
  const sourceUrl = bytesToDataUrl(props.bytes, props.mimeType);
  return (
    <div
      className="profile-crop-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <section
        className="profile-crop-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-crop-title"
      >
        <div className="profile-crop-heading">
          <div>
            <h3 id="avatar-crop-title">调整头像</h3>
            <p>拖动图片并缩放，预览将以圆形头像显示。</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭裁剪"
            onClick={props.onCancel}
          >
            <X size={17} />
          </button>
        </div>
        {sourceUrl === null ? (
          <div className="profile-crop-loading">
            <LoaderCircle size={20} className="spin" />
          </div>
        ) : (
          <CropViewport sourceUrl={sourceUrl} zoom={zoom} onZoom={setZoom} onCrop={updateCrop} />
        )}
        <div className="profile-crop-actions">
          <button className="secondary-button" type="button" onClick={props.onCancel}>
            取消
          </button>
          <button
            className="primary-button compact-primary"
            type="button"
            disabled={crop === null}
            onClick={() => crop !== null && props.onConfirm(crop)}
          >
            使用此头像
          </button>
        </div>
      </section>
    </div>
  );
}

function CropViewport(props: {
  readonly sourceUrl: string;
  readonly zoom: number;
  onZoom(value: number): void;
  onCrop(crop: CropRect): void;
}) {
  const size = 240;
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly offsetX: number;
    readonly offsetY: number;
  } | null>(null);
  const [dimensions, setDimensions] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const scale =
    dimensions === null
      ? 1
      : Math.max(size / dimensions.width, size / dimensions.height) * props.zoom;
  const imageWidth = (dimensions?.width ?? size) * scale;
  const imageHeight = (dimensions?.height ?? size) * scale;

  useEffect(() => {
    const image = imageRef.current;
    // A cached image can finish loading before this source-change effect runs.
    setDimensions(
      image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0
        ? { width: image.naturalWidth, height: image.naturalHeight }
        : null,
    );
    setOffset({ x: 0, y: 0 });
  }, [props.sourceUrl]);

  useEffect(() => {
    setOffset((current) => ({
      x: clamp(current.x, -(imageWidth - size) / 2, (imageWidth - size) / 2),
      y: clamp(current.y, -(imageHeight - size) / 2, (imageHeight - size) / 2),
    }));
  }, [imageWidth, imageHeight]);

  useEffect(() => {
    if (dimensions === null) return;
    // Scaling can round a covered axis just below the viewport size.
    const width = Math.min(1, size / imageWidth);
    const height = Math.min(1, size / imageHeight);
    props.onCrop({
      x: clamp(0.5 + (-offset.x - size / 2) / imageWidth, 0, 1 - width),
      y: clamp(0.5 + (-offset.y - size / 2) / imageHeight, 0, 1 - height),
      width,
      height,
    });
  }, [dimensions, imageWidth, imageHeight, offset, props.onCrop]);

  const clampOffset = (next: { x: number; y: number }) => ({
    x: clamp(next.x, -(imageWidth - size) / 2, (imageWidth - size) / 2),
    y: clamp(next.y, -(imageHeight - size) / 2, (imageHeight - size) / 2),
  });
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (dimensions === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    setOffset(
      clampOffset({
        x: current.offsetX + event.clientX - current.x,
        y: current.offsetY + event.clientY - current.y,
      }),
    );
  };

  return (
    <div className="profile-crop-workspace">
      <div
        className="profile-crop-viewport"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        aria-label="拖动图片调整头像裁剪区域"
      >
        <img
          ref={imageRef}
          src={props.sourceUrl}
          alt=""
          draggable={false}
          onLoad={(event) =>
            setDimensions({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          style={{
            width: imageWidth,
            height: imageHeight,
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
          }}
        />
        <span className="profile-crop-circle" aria-hidden="true" />
      </div>
      <label className="profile-crop-zoom">
        <span>缩放</span>
        <input
          type="range"
          min="1"
          max="3"
          step="0.01"
          value={props.zoom}
          onChange={(event) => {
            props.onZoom(Number(event.target.value));
            requestAnimationFrame(() => setOffset((current) => clampOffset(current)));
          }}
        />
      </label>
      <p>上传后会由 Cloud 裁切并转换为 512 × 512 WebP，账户页以圆形显示。</p>
    </div>
  );
}

async function createCropPreview(
  bytes: Uint8Array,
  mimeType: AvatarMimeType,
  crop: CropRect,
): Promise<string> {
  const image = new Image();
  image.src = bytesToDataUrl(bytes, mimeType);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("头像预览暂时不可用。");
  context.drawImage(
    image,
    crop.x * image.naturalWidth,
    crop.y * image.naturalHeight,
    crop.width * image.naturalWidth,
    crop.height * image.naturalHeight,
    0,
    0,
    512,
    512,
  );
  return canvas.toDataURL("image/webp", 0.86);
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: AvatarMimeType | "image/webp"): string {
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function avatarFallback(value: string): string {
  const first = Array.from(value.trim())[0];
  return first?.toLocaleUpperCase() ?? "C";
}

function hasDesktopEntitlement(entitlements: readonly AccountEntitlement[]): boolean {
  return entitlements.some((item) => item.code === "CAELUSH_DESKTOP_BASIC" && item.enabled);
}

function formatUsageCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatUsageTokens(bucket: AccountCenterSnapshot["usage"]["since"]): string {
  if (bucket.successfulRequests === 0) return "0";
  return bucket.totalTokens === null ? "—" : formatUsageCount(bucket.totalTokens);
}

function formatSessionDate(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "最近更新";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
