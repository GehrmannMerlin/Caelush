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
import type { DesktopProfileCenterApi } from "../../preload/api-types.js";

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
  onOpenModelSettings(): void;
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
      .getSnapshot({ sinceMs: monthStart })
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
            <div className="account-center-usage" aria-label="模型调用用量">
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
          <button
            className="account-center-row is-action"
            type="button"
            onClick={props.onOpenModelSettings}
          >
            <span className="account-center-row-copy">
              <b>模型与 API Key</b>
              <small>管理已连接的模型服务与密钥</small>
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
              <b>登录设备</b>
              <small>查看已授权设备，或撤销不再使用的设备</small>
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
              <b>切换账户</b>
              <small>退出当前账户后，可以登录其他账户</small>
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
