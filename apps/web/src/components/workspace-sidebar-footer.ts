import { createElement, useEffect, useRef, useState, type ReactElement } from "react";
import { Archive, LogOut, RefreshCw, Settings, SlidersHorizontal, Sun } from "lucide-react";

export interface WorkspaceSidebarDesktopActions {
  readonly accountHref?: string | undefined;
  readonly archiveHref?: string | undefined;
  readonly accountProfile?:
    { readonly displayName: string; readonly avatarBytes: Uint8Array | null } | undefined;
  readonly onCheckUpdates?: (() => void) | undefined;
  readonly onLogout?: (() => void) | undefined;
}

export interface WorkspaceSettingsMenuProps {
  readonly onOpenArchives?: (() => void) | undefined;
  readonly onOpenAppearance?: (() => void) | undefined;
  readonly archiveHref?: string | undefined;
  readonly onSelect: () => void;
  readonly onCheckUpdates?: (() => void) | undefined;
  readonly onLogout?: (() => void) | undefined;
}

export function WorkspaceSettingsMenu(props: WorkspaceSettingsMenuProps): ReactElement {
  return createElement(
    "div",
    {
      id: "workspace-settings-menu",
      className: "workspace-settings-menu",
      role: "menu",
      "aria-label": "设置选项",
    },
    createElement(
      "button",
      {
        type: "button",
        className: "workspace-settings-menu-item",
        role: "menuitem",
        onClick: props.onSelect,
      },
      createElement(SlidersHorizontal, { size: 16, strokeWidth: 2, "aria-hidden": true }),
      createElement("span", null, "模型与配置"),
    ),
    props.onOpenAppearance === undefined
      ? null
      : createElement(
          "button",
          {
            type: "button",
            className: "workspace-settings-menu-item",
            role: "menuitem",
            onClick: props.onOpenAppearance,
          },
          createElement(Sun, { size: 16, strokeWidth: 2, "aria-hidden": true }),
          createElement("span", null, "外观"),
        ),
    props.archiveHref !== undefined
      ? createElement(
          "a",
          { className: "workspace-settings-menu-item", role: "menuitem", href: props.archiveHref },
          createElement(Archive, { size: 16, "aria-hidden": true }),
          createElement("span", null, "已归档"),
        )
      : props.onOpenArchives === undefined
        ? null
        : createElement(
            "button",
            {
              type: "button",
              className: "workspace-settings-menu-item",
              role: "menuitem",
              onClick: props.onOpenArchives,
            },
            createElement(Archive, { size: 16, "aria-hidden": true }),
            createElement("span", null, "已归档"),
          ),
    props.onCheckUpdates === undefined
      ? null
      : createElement(
          "button",
          {
            type: "button",
            className: "workspace-settings-menu-item",
            role: "menuitem",
            onClick: props.onCheckUpdates,
          },
          createElement(RefreshCw, { size: 16, strokeWidth: 2, "aria-hidden": true }),
          createElement("span", null, "检查更新"),
        ),
    props.onLogout === undefined
      ? null
      : createElement(
          "button",
          {
            type: "button",
            className: "workspace-settings-menu-item",
            role: "menuitem",
            onClick: props.onLogout,
          },
          createElement(LogOut, { size: 16, strokeWidth: 2, "aria-hidden": true }),
          createElement("span", null, "退出登录"),
        ),
  );
}

export function WorkspaceSidebarFooter(props: {
  readonly onOpenArchives?: (() => void) | undefined;
  readonly onOpenSettings?: (() => void) | undefined;
  readonly onOpenAppearance?: (() => void) | undefined;
  readonly desktopActions?: WorkspaceSidebarDesktopActions | undefined;
}): ReactElement {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsControlRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const { desktopActions } = props;
  const accountName = desktopActions?.accountProfile?.displayName ?? "Caelush";
  const avatarBytes = desktopActions?.accountProfile?.avatarBytes;
  const avatarSource =
    avatarBytes === null || avatarBytes === undefined || avatarBytes.length === 0
      ? null
      : avatarBytesToDataUrl(avatarBytes);

  useEffect(() => {
    if (!settingsMenuOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !settingsControlRef.current?.contains(target)) {
        setSettingsMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setSettingsMenuOpen(false);
      settingsButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [settingsMenuOpen]);

  const select = (action: (() => void) | undefined): (() => void) | undefined =>
    action === undefined
      ? undefined
      : () => {
          setSettingsMenuOpen(false);
          action();
        };

  return createElement(
    "div",
    {
      className: `workspace-sidebar-footer${desktopActions === undefined ? "" : " workspace-sidebar-footer--desktop"}`,
      role: desktopActions === undefined ? undefined : "group",
      "aria-label": desktopActions === undefined ? undefined : "桌面端账户与设置",
    },
    desktopActions?.accountHref === undefined
      ? null
      : createElement(
          "a",
          {
            className: "workspace-settings-button workspace-account-link",
            href: desktopActions.accountHref,
          },
          createElement(
            "span",
            { className: "workspace-account-avatar", "aria-hidden": true },
            avatarSource === null
              ? firstAccountCharacter(accountName)
              : createElement("img", { src: avatarSource, alt: "" }),
          ),
          createElement("span", { className: "workspace-account-name" }, accountName),
        ),
    createElement(
      "div",
      { className: "workspace-settings-control", ref: settingsControlRef },
      createElement(
        "button",
        {
          type: "button",
          className: "workspace-settings-button",
          ref: settingsButtonRef,
          onClick: () => setSettingsMenuOpen((open) => !open),
          "aria-label": desktopActions === undefined ? undefined : "设置",
          "aria-haspopup": "menu",
          "aria-expanded": settingsMenuOpen,
        },
        createElement(Settings, { size: 16, strokeWidth: 2.1, "aria-hidden": true }),
        desktopActions === undefined ? createElement("span", null, "设置") : null,
      ),
      settingsMenuOpen
        ? createElement(WorkspaceSettingsMenu, {
            onOpenArchives: select(props.onOpenArchives),
            onOpenAppearance: select(props.onOpenAppearance),
            archiveHref: desktopActions?.archiveHref,
            onSelect: () => {
              setSettingsMenuOpen(false);
              props.onOpenSettings?.();
            },
            onCheckUpdates: select(desktopActions?.onCheckUpdates),
            onLogout: select(desktopActions?.onLogout),
          })
        : null,
    ),
  );
}

function avatarBytesToDataUrl(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return `data:image/webp;base64,${btoa(binary)}`;
}

function firstAccountCharacter(value: string): string {
  return Array.from(value.trim())[0]?.toLocaleUpperCase() ?? "C";
}
