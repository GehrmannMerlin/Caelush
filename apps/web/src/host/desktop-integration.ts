import type { DesktopPanelApi } from "./desktop-panel-api.js";
import type { AppearanceSnapshot, ThemePreference } from "@caelush/ui-theme/appearance";

export const CAELUSH_DESKTOP_PROTOCOL_VERSION = 1 as const;

interface DesktopAccountBridge {
  readonly logout: () => Promise<{ readonly serverRevoked: boolean }>;
  readonly getSidebarProfile?: (() => Promise<DesktopSidebarProfile>) | undefined;
}

export interface DesktopSidebarProfile {
  readonly displayName: string;
  readonly avatarBytes: Uint8Array | null;
}

export interface DesktopUpdateState {
  readonly status: string;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly message: string;
  readonly releaseNotes: string;
  readonly artifactSize: number;
  readonly downloadedBytes: number;
  readonly mandatory: boolean;
}

export interface DesktopUpdateBridge {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<unknown>;
  download(): Promise<unknown>;
  install(): Promise<unknown>;
  cancelDownload(): Promise<unknown>;
  deferInstall(): Promise<unknown>;
  subscribeState(listener: (state: DesktopUpdateState) => void): () => void;
}

export interface DesktopAppearanceBridge {
  readonly capabilityVersion: 1;
  readonly initialSnapshot: AppearanceSnapshot;
  getSnapshot(): Promise<AppearanceSnapshot>;
  setPreference(preference: ThemePreference): Promise<AppearanceSnapshot>;
  subscribe(listener: (snapshot: AppearanceSnapshot) => void): () => void;
}

export interface DesktopBridgeV1 {
  readonly protocolVersion: typeof CAELUSH_DESKTOP_PROTOCOL_VERSION;
  readonly account?: DesktopAccountBridge | undefined;
  readonly appearance?: DesktopAppearanceBridge | undefined;
  readonly update?: DesktopUpdateBridge | undefined;
  readonly workspace?: DesktopPanelApi["workspace"] | undefined;
  readonly browser?: DesktopPanelApi["browser"] | undefined;
}

export type ClientHostIntegration =
  | { readonly kind: "WEB"; readonly loadingUi: false }
  | {
      readonly kind: "DESKTOP";
      readonly loadingUi: true;
      readonly appearance?: DesktopAppearanceBridge | undefined;
      readonly account?:
        | {
            readonly href: "caelush-login://app/?view=account";
            readonly archiveHref: "caelush-login://app/?view=account&section=archives";
            readonly logout: DesktopAccountBridge["logout"];
            readonly getSidebarProfile?: DesktopAccountBridge["getSidebarProfile"];
          }
        | undefined;
      readonly updates?: { readonly check: DesktopUpdateBridge["check"] } | undefined;
      readonly updateSettings?: DesktopUpdateBridge | undefined;
      readonly panelApi: DesktopPanelApi | null;
    };

interface DesktopBridgeCarrier {
  readonly caelushDesktop?: unknown;
}

declare global {
  interface Window {
    readonly caelushDesktop?: DesktopBridgeV1;
  }
}

export function resolveClientHostIntegration(
  source: DesktopBridgeCarrier = typeof window === "undefined" ? {} : window,
): ClientHostIntegration {
  const bridge = source.caelushDesktop;
  if (!isRecord(bridge) || bridge.protocolVersion !== CAELUSH_DESKTOP_PROTOCOL_VERSION) {
    return { kind: "WEB", loadingUi: false };
  }

  const account =
    isRecord(bridge.account) && typeof bridge.account.logout === "function"
      ? {
          href: "caelush-login://app/?view=account" as const,
          archiveHref: "caelush-login://app/?view=account&section=archives" as const,
          logout: bridge.account.logout as DesktopAccountBridge["logout"],
          ...(typeof bridge.account.getSidebarProfile === "function"
            ? {
                getSidebarProfile: bridge.account
                  .getSidebarProfile as DesktopAccountBridge["getSidebarProfile"],
              }
            : {}),
        }
      : undefined;
  const appearance = isDesktopAppearanceBridge(bridge.appearance)
    ? (bridge.appearance as unknown as DesktopAppearanceBridge)
    : undefined;
  const updates =
    isRecord(bridge.update) && typeof bridge.update.check === "function"
      ? { check: bridge.update.check as DesktopUpdateBridge["check"] }
      : undefined;

  return {
    kind: "DESKTOP",
    loadingUi: true,
    ...(appearance === undefined ? {} : { appearance }),
    ...(account === undefined ? {} : { account }),
    ...(updates === undefined ? {} : { updates }),
    ...(hasMethods(bridge.update, [
      "getState",
      "check",
      "download",
      "install",
      "cancelDownload",
      "deferInstall",
      "subscribeState",
    ])
      ? { updateSettings: bridge.update as unknown as DesktopUpdateBridge }
      : {}),
    panelApi: isDesktopPanelApi(bridge) ? bridge : null,
  };
}

function isDesktopAppearanceBridge(value: unknown): value is DesktopAppearanceBridge {
  if (!isRecord(value) || value.capabilityVersion !== 1) return false;
  return (
    isAppearanceSnapshot(value.initialSnapshot) &&
    typeof value.getSnapshot === "function" &&
    typeof value.setPreference === "function" &&
    typeof value.subscribe === "function"
  );
}

function isAppearanceSnapshot(value: unknown): value is AppearanceSnapshot {
  return (
    isRecord(value) &&
    (value.preference === "light" ||
      value.preference === "dark" ||
      value.preference === "system") &&
    (value.resolvedTheme === "light" || value.resolvedTheme === "dark") &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

function isDesktopPanelApi(value: unknown): value is DesktopPanelApi {
  if (!isRecord(value)) return false;
  if (!isRecord(value.workspace)) return false;
  return (
    hasMethods(value.workspace, [
      "getAvailability",
      "subscribeAvailability",
      "activate",
      "listEntries",
      "previewText",
      "listEditors",
      "openInEditor",
    ]) &&
    hasMethods(value.workspace.terminal, [
      "create",
      "write",
      "resize",
      "close",
      "subscribeOutput",
      "acknowledgeOutput",
    ]) &&
    hasMethods(value.browser, [
      "createLease",
      "navigate",
      "goBack",
      "goForward",
      "reload",
      "setBounds",
      "closeLease",
      "subscribeState",
    ])
  );
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return isRecord(value) && methods.every((method) => typeof value[method] === "function");
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
