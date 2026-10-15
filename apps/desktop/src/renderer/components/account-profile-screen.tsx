import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent,
} from "react";
import {
  BadgeCheck,
  Camera,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  X,
} from "lucide-react";
import type { DesktopAccountProfile } from "../../main/account/state.js";
import type { AccountProfileUpdateInput } from "../../main/cloud/schemas.js";

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
  readonly currentPassword: string;
  readonly newPassword: string;
  setCurrentPassword(value: string): void;
  setNewPassword(value: string): void;
  onSelectAvatar(): Promise<{
    readonly mimeType: AvatarMimeType;
    readonly bytes: Uint8Array;
  } | null>;
  onSave(input: AccountProfileUpdateInput): Promise<DesktopAccountProfile>;
  onChangePassword(event: FormEvent<HTMLFormElement>): void;
}

export function AccountProfileScreen(props: Props) {
  const [displayName, setDisplayName] = useState("");
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
  const [messageTone, setMessageTone] = useState<"info" | "error">("info");
  const [dirty, setDirty] = useState(false);
  const imageUrl = useMemo(() => {
    if (props.profile?.avatarBytes === null || props.profile === null) return null;
    return bytesToDataUrl(props.profile.avatarBytes, "image/webp");
  }, [props.profile?.avatarBytes, props.profile]);

  useEffect(() => {
    if (props.profile === null || dirty) return;
    setDisplayName(props.profile.displayName);
    setSelection(null);
    setRemoveAvatar(false);
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

  const visibleAvatarUrl = selection !== null ? previewUrl : removeAvatar ? null : imageUrl;
  const canSave =
    props.online &&
    props.profile?.canEdit === true &&
    dirty &&
    !saving &&
    !props.busy &&
    Array.from(displayName.normalize("NFC").trim()).length >= 1 &&
    Array.from(displayName.normalize("NFC").trim()).length <= 32 &&
    !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(displayName);

  const chooseAvatar = async () => {
    setChoosing(true);
    setMessage(null);
    try {
      const selected = await props.onSelectAvatar();
      if (selected !== null) setCropSource(selected);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法读取所选图片。");
      setMessageTone("error");
    } finally {
      setChoosing(false);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setMessage(null);
    try {
      const input: AccountProfileUpdateInput = {
        displayName: displayName.normalize("NFC").trim(),
        removeAvatar,
        ...(selection === null
          ? {}
          : {
              avatar: {
                bytes: new Uint8Array(selection.bytes) as Uint8Array<ArrayBuffer>,
                contentType: selection.mimeType,
                crop: selection.crop,
              },
            }),
      };
      await props.onSave(input);
      setSelection(null);
      setRemoveAvatar(false);
      setDirty(false);
      setMessage("个人信息已保存。");
      setMessageTone("info");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法保存个人信息。");
      setMessageTone("error");
    } finally {
      setSaving(false);
    }
  };

  const cancelChanges = () => {
    setDisplayName(props.profile?.displayName ?? "");
    setSelection(null);
    setRemoveAvatar(false);
    setDirty(false);
    setMessage(null);
  };

  const acceptCrop = (crop: CropRect) => {
    if (cropSource === null) return;
    setSelection({ ...cropSource, crop });
    setCropSource(null);
    setRemoveAvatar(false);
    setDirty(true);
  };

  return (
    <div className="account-profile-stack">
      <section className="table-panel profile-card">
        <div className="table-heading">
          <div>
            <h3>个人信息</h3>
            <p>更新你的展示名和头像。邮箱与验证状态只读。</p>
          </div>
          <BadgeCheck size={18} aria-hidden="true" />
        </div>
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
          <form className="profile-edit-form" onSubmit={(event) => void save(event)}>
            <div className="profile-avatar-row">
              <div className="profile-avatar-frame">
                {visibleAvatarUrl !== null ? (
                  <img src={visibleAvatarUrl} alt="头像预览" />
                ) : (
                  <span>{avatarFallback(displayName || props.profile.displayName)}</span>
                )}
              </div>
              <div className="profile-avatar-actions">
                <strong>头像</strong>
                <span>PNG、JPEG 或 WebP，最大 5 MB</span>
                <div className="profile-action-row">
                  <button
                    className="secondary-button profile-action-button"
                    type="button"
                    disabled={
                      !props.online || !props.profile.canEdit || choosing || props.busy || saving
                    }
                    onClick={() => void chooseAvatar()}
                  >
                    {choosing ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />}
                    选择图片
                  </button>
                  {(selection !== null || props.profile.avatarRevision !== null) && (
                    <button
                      className="text-button profile-remove-avatar"
                      type="button"
                      disabled={!props.online || !props.profile.canEdit || saving || props.busy}
                      onClick={() => {
                        setSelection(null);
                        setRemoveAvatar(true);
                        setDirty(true);
                      }}
                    >
                      移除头像
                    </button>
                  )}
                </div>
              </div>
            </div>
            <label className="field-label" htmlFor="profile-display-name">
              展示名
            </label>
            <div className="input-wrap profile-name-input">
              <input
                id="profile-display-name"
                autoComplete="nickname"
                maxLength={64}
                value={displayName}
                disabled={!props.online || !props.profile.canEdit || saving || props.busy}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  setDirty(true);
                  setMessage(null);
                }}
              />
            </div>
            <p className="profile-field-hint">1–32 个 Unicode 字符，保存时会去除首尾空格。</p>
            <label className="field-label" htmlFor="profile-email">
              邮箱地址
            </label>
            <div className="input-wrap profile-name-input">
              <Mail size={16} aria-hidden="true" />
              <input id="profile-email" value={props.profile.email} readOnly />
              <span
                className={`profile-verified${props.profile.emailVerified ? " is-verified" : ""}`}
              >
                {props.profile.emailVerified ? "已验证" : "未验证"}
              </span>
            </div>
            {message !== null && !props.loading && (
              <p
                className={`account-profile-feedback${messageTone === "error" ? " is-error" : ""}`}
                role={messageTone === "error" ? "alert" : "status"}
              >
                {message}
              </p>
            )}
            <div className="profile-form-actions">
              {dirty && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving || props.busy}
                  onClick={cancelChanges}
                >
                  取消
                </button>
              )}
              <button className="primary-button compact-primary" type="submit" disabled={!canSave}>
                {saving ? <LoaderCircle size={15} className="spin" /> : null} 保存更改
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="table-panel password-panel">
        <div className="table-heading">
          <div>
            <h3>修改密码</h3>
            <p>修改密码后，其他已登录的账户会话将会失效。</p>
          </div>
          <KeyRound size={18} aria-hidden="true" />
        </div>
        {!props.online && (
          <div className="account-profile-banner">请先连接云端，再修改账户密码。</div>
        )}
        <form className="password-change-form" onSubmit={props.onChangePassword}>
          <label className="field-label" htmlFor="current-password">
            当前密码
          </label>
          <div className="input-wrap">
            <LockKeyhole size={16} aria-hidden="true" />
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              minLength={1}
              maxLength={1024}
              required
              disabled={!props.online || props.busy}
              value={props.currentPassword}
              onChange={(event) => props.setCurrentPassword(event.target.value)}
            />
          </div>
          <label className="field-label" htmlFor="new-password">
            新密码
          </label>
          <div className="input-wrap">
            <KeyRound size={16} aria-hidden="true" />
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={1}
              maxLength={1024}
              required
              disabled={!props.online || props.busy}
              value={props.newPassword}
              onChange={(event) => props.setNewPassword(event.target.value)}
            />
          </div>
          <button
            className="primary-button compact-primary"
            type="submit"
            disabled={!props.online || props.busy}
          >
            {props.busy ? <LoaderCircle size={15} className="spin" /> : null} 修改密码
          </button>
        </form>
      </section>

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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
