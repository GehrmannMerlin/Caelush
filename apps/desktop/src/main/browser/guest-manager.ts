import { randomBytes } from "node:crypto";
import {
  session as electronSession,
  WebContentsView,
  type BrowserWindow,
  type Session,
} from "electron";
import type { AccountProfile } from "../profiles/profile-manager.js";
import {
  BrowserGuestError,
  validateBrowserUrl,
  validateBrowserUrlSyntax,
  type BrowserUrlPolicyOptions,
} from "./url-policy.js";

const OPAQUE_LEASE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SAFE_ERROR_CODES = new Set(["BROWSER_NAVIGATION_FAILED", "BROWSER_GUEST_CRASHED"]);
const GUEST_DESTROY_TIMEOUT_MS = 5000;

export interface BrowserGuestIdentity {
  readonly userId: string;
  readonly profileId: string;
  readonly generationId: string;
  readonly profile: AccountProfile;
}

export interface BrowserGuestBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserGuestState {
  readonly leaseId: string;
  readonly url: string;
  readonly loading: boolean;
  readonly errorCode?: "BROWSER_NAVIGATION_FAILED" | "BROWSER_GUEST_CRASHED";
}

export interface BrowserGuestManagerOptions {
  readonly window: BrowserWindow;
  readonly getCurrentIdentity: () => BrowserGuestIdentity | null;
  readonly sendState: (ownerId: number, state: BrowserGuestState) => void;
  readonly sessionFromPath?: (browserDirectory: string) => Session;
  readonly createView?: (guestSession: Session) => WebContentsView;
  readonly policy?: BrowserUrlPolicyOptions;
  readonly platform?: NodeJS.Platform;
}

interface ActiveGuest {
  readonly ownerId: number;
  readonly leaseId: string;
  readonly identity: BrowserGuestIdentity;
  readonly guestSession: Session;
  readonly view: WebContentsView;
  readonly listeners: Array<() => void>;
  url: string;
  loading: boolean;
  errorCode?: BrowserGuestState["errorCode"];
  bounds?: BrowserGuestBounds;
  boundsContentSize?: readonly [number, number];
  closePromise?: Promise<void>;
}

export class BrowserGuestManager {
  private guest: ActiveGuest | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly resizeListener: () => void;
  private readonly lockedSessions = new WeakSet<Session>();
  private readonly closingGuests = new Set<Promise<void>>();

  constructor(private readonly options: BrowserGuestManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.resizeListener = () => this.resizeWithWindow();
    options.window.on("resize", this.resizeListener);
    options.window.on("closed", () => {
      void this.closeAll().catch(() => undefined);
    });
  }

  async createLease(ownerId: number, bounds: BrowserGuestBounds): Promise<BrowserGuestState> {
    await Promise.all(this.closingGuests);
    const identity = this.requireCurrentIdentity();
    this.assertOwner(ownerId);
    const validatedBounds = this.validateBounds(bounds);
    if (this.guest !== undefined) {
      if (this.guest.ownerId !== ownerId || !sameIdentity(this.guest.identity, identity)) {
        await this.closeAll();
      } else {
        this.setGuestBounds(this.guest, validatedBounds);
        return this.state(this.guest);
      }
    }

    try {
      const guestSession = (
        this.options.sessionFromPath ??
        ((directory) => electronSession.fromPath(directory, { cache: true }))
      )(identity.profile.browserDirectory);
      this.lockSession(guestSession);
      const view = (
        this.options.createView ??
        ((selectedSession) =>
          new WebContentsView({
            webPreferences: {
              session: selectedSession,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true,
              allowRunningInsecureContent: false,
              webviewTag: false,
              spellcheck: false,
              devTools: false,
            },
          }))
      )(guestSession);
      const guest: ActiveGuest = {
        ownerId,
        leaseId: randomBytes(32).toString("base64url"),
        identity,
        guestSession,
        view,
        listeners: [],
        url: "",
        loading: false,
      };
      this.guest = guest;
      this.options.window.contentView.addChildView(view);
      view.setVisible(false);
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.bindGuestEvents(guest);
      this.setGuestBounds(guest, validatedBounds);
      return this.state(guest);
    } catch (error) {
      if (this.guest !== undefined) await this.closeAll();
      if (error instanceof BrowserGuestError) throw error;
      throw new BrowserGuestError(
        "BROWSER_GUEST_UNAVAILABLE",
        "The isolated Browser Guest could not be created.",
      );
    }
  }

  async navigate(
    ownerId: number,
    leaseId: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<BrowserGuestState> {
    const guest = this.requireGuest(ownerId, leaseId);
    const url = await validateBrowserUrl(value, this.options.policy);
    if (signal?.aborted) {
      throw new BrowserGuestError(
        "BROWSER_LEASE_INVALID",
        "The Browser Guest request was cancelled.",
      );
    }
    this.assertGuestCurrent(guest);
    guest.url = url;
    guest.loading = true;
    delete guest.errorCode;
    this.publish(guest);
    const abortLoad = () => guest.view.webContents.stop();
    signal?.addEventListener("abort", abortLoad, { once: true });
    try {
      await guest.view.webContents.loadURL(url);
    } catch {
      if (signal?.aborted) {
        guest.loading = false;
        throw new BrowserGuestError(
          "BROWSER_NAVIGATION_FAILED",
          "The Browser Guest request was cancelled.",
        );
      }
      guest.loading = false;
      guest.errorCode = "BROWSER_NAVIGATION_FAILED";
      this.publish(guest);
    } finally {
      signal?.removeEventListener("abort", abortLoad);
    }
    if (signal?.aborted)
      throw new BrowserGuestError(
        "BROWSER_NAVIGATION_FAILED",
        "The Browser Guest request was cancelled.",
      );
    return this.state(guest);
  }

  goBack(ownerId: number, leaseId: string): BrowserGuestState {
    const guest = this.requireGuest(ownerId, leaseId);
    this.assertGuestCurrent(guest);
    if (guest.view.webContents.navigationHistory.canGoBack())
      guest.view.webContents.navigationHistory.goBack();
    return this.state(guest);
  }

  goForward(ownerId: number, leaseId: string): BrowserGuestState {
    const guest = this.requireGuest(ownerId, leaseId);
    this.assertGuestCurrent(guest);
    if (guest.view.webContents.navigationHistory.canGoForward())
      guest.view.webContents.navigationHistory.goForward();
    return this.state(guest);
  }

  reload(ownerId: number, leaseId: string): BrowserGuestState {
    const guest = this.requireGuest(ownerId, leaseId);
    this.assertGuestCurrent(guest);
    guest.view.webContents.reload();
    return this.state(guest);
  }

  setBounds(ownerId: number, leaseId: string, bounds: BrowserGuestBounds | null): void {
    const guest = this.requireGuest(ownerId, leaseId);
    this.assertGuestCurrent(guest);
    if (bounds === null) {
      guest.view.setVisible(false);
      delete guest.bounds;
      delete guest.boundsContentSize;
      return;
    }
    this.setGuestBounds(guest, this.validateBounds(bounds));
  }

  getState(ownerId: number, leaseId: string): BrowserGuestState {
    return this.state(this.requireGuest(ownerId, leaseId));
  }

  async closeLease(ownerId: number, leaseId: string): Promise<void> {
    const guest = this.requireGuest(ownerId, leaseId);
    await this.destroyGuest(guest);
  }

  async closeAll(): Promise<void> {
    const guest = this.guest;
    const closing = [...this.closingGuests];
    if (guest !== undefined) closing.push(this.destroyGuest(guest));
    await Promise.all(closing);
  }

  dispose(): void {
    this.options.window.removeListener("resize", this.resizeListener);
    void this.closeAll().catch(() => undefined);
  }

  private lockSession(guestSession: Session): void {
    if (this.lockedSessions.has(guestSession)) return;
    this.lockedSessions.add(guestSession);
    guestSession.setPermissionCheckHandler(() => false);
    guestSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    guestSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const guest = this.guest;
      if (guest === undefined || details.webContentsId !== guest.view.webContents.id) {
        callback({ cancel: true });
        return;
      }
      void validateBrowserUrl(details.url, this.options.policy)
        .then(() => {
          if (this.isGuestCurrent(guest)) callback({ cancel: false });
          else callback({ cancel: true });
        })
        .catch(() => callback({ cancel: true }));
    });
    guestSession.on("will-download", (event, _item, contents) => {
      if (this.guest?.view.webContents === contents) event.preventDefault();
    });
  }

  private bindGuestEvents(guest: ActiveGuest): void {
    const contents = guest.view.webContents;
    const bind = (event: string, listener: (...args: unknown[]) => void) => {
      const typedListener = listener as never;
      contents.on(event as never, typedListener);
      guest.listeners.push(() => contents.removeListener(event as never, typedListener));
    };
    bind("will-navigate", (event, destination) => {
      if (typeof destination !== "string" || validateBrowserUrlSyntax(destination) === null) {
        (event as { preventDefault(): void }).preventDefault();
      }
    });
    bind("will-redirect", (event, destination) => {
      if (typeof destination !== "string" || validateBrowserUrlSyntax(destination) === null) {
        (event as { preventDefault(): void }).preventDefault();
      }
    });
    bind("did-start-loading", () => {
      if (!this.isGuestCurrent(guest)) return;
      guest.loading = true;
      this.publish(guest);
    });
    bind("did-stop-loading", () => {
      if (!this.isGuestCurrent(guest)) return;
      guest.loading = false;
      this.publish(guest);
    });
    bind("did-navigate", (_event, url) => {
      if (!this.isGuestCurrent(guest) || typeof url !== "string") return;
      guest.url = url;
      delete guest.errorCode;
      this.publish(guest);
    });
    bind("did-navigate-in-page", (_event, url) => {
      if (!this.isGuestCurrent(guest) || typeof url !== "string") return;
      guest.url = url;
      this.publish(guest);
    });
    bind("did-fail-load", (_event, errorCode) => {
      if (!this.isGuestCurrent(guest) || errorCode === -3) return;
      guest.loading = false;
      guest.errorCode = "BROWSER_NAVIGATION_FAILED";
      this.publish(guest);
    });
    bind("render-process-gone", () => {
      if (!this.isGuestCurrent(guest)) return;
      guest.loading = false;
      guest.errorCode = "BROWSER_GUEST_CRASHED";
      this.publish(guest);
      void this.destroyGuest(guest).catch(() => undefined);
    });
    bind("destroyed", () => {
      if (this.guest === guest) this.guest = undefined;
    });
  }

  private validateBounds(bounds: BrowserGuestBounds): BrowserGuestBounds {
    const [contentWidth = 0, contentHeight = 0] = this.options.window.getContentSize();
    const values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if (
      values.some((value) => !Number.isInteger(value) || !Number.isFinite(value)) ||
      bounds.x < Math.floor(contentWidth * 0.64) ||
      bounds.y < 48 ||
      bounds.width < 140 ||
      bounds.height < 120 ||
      bounds.x + bounds.width > contentWidth ||
      bounds.y + bounds.height > contentHeight ||
      bounds.x < 0 ||
      bounds.y < 0
    ) {
      throw new BrowserGuestError(
        "BROWSER_BOUNDS_INVALID",
        "The Browser Guest must remain inside the right workspace panel.",
      );
    }
    return { ...bounds };
  }

  private setGuestBounds(guest: ActiveGuest, bounds: BrowserGuestBounds): void {
    guest.view.setBounds(bounds);
    guest.view.setVisible(true);
    guest.bounds = bounds;
    const [contentWidth = 0, contentHeight = 0] = this.options.window.getContentSize();
    guest.boundsContentSize = [contentWidth, contentHeight];
  }

  private resizeWithWindow(): void {
    const guest = this.guest;
    if (guest === undefined || guest.bounds === undefined || guest.boundsContentSize === undefined)
      return;
    try {
      const [previousWidth, previousHeight] = guest.boundsContentSize;
      const [nextWidth = 0, nextHeight = 0] = this.options.window.getContentSize();
      const resized = this.validateBounds({
        x: Math.round((guest.bounds.x / previousWidth) * nextWidth),
        y: Math.round((guest.bounds.y / previousHeight) * nextHeight),
        width: Math.round((guest.bounds.width / previousWidth) * nextWidth),
        height: Math.round((guest.bounds.height / previousHeight) * nextHeight),
      });
      guest.view.setBounds(resized);
      guest.bounds = resized;
      guest.boundsContentSize = [nextWidth, nextHeight];
    } catch {
      guest.view.setVisible(false);
      delete guest.bounds;
      delete guest.boundsContentSize;
    }
  }

  private requireCurrentIdentity(): BrowserGuestIdentity {
    const identity = this.options.getCurrentIdentity();
    if (
      identity === null ||
      identity.profile.profileId !== identity.profileId ||
      identity.profile.browserDirectory.length === 0
    ) {
      throw new BrowserGuestError(
        "BROWSER_LEASE_INVALID",
        "Browser Guest requires an authorized Desktop Profile.",
      );
    }
    return identity;
  }

  private requireGuest(ownerId: number, leaseId: string): ActiveGuest {
    const guest = this.guest;
    if (
      guest === undefined ||
      guest.ownerId !== ownerId ||
      !OPAQUE_LEASE_PATTERN.test(leaseId) ||
      guest.leaseId !== leaseId
    ) {
      throw new BrowserGuestError("BROWSER_LEASE_INVALID", "The Browser Guest lease is invalid.");
    }
    this.assertGuestCurrent(guest);
    return guest;
  }

  private assertOwner(ownerId: number): void {
    if (
      this.options.window.isDestroyed() ||
      this.options.window.webContents.isDestroyed() ||
      ownerId !== this.options.window.webContents.id
    ) {
      throw new BrowserGuestError(
        "BROWSER_LEASE_INVALID",
        "The Browser Guest owner is no longer available.",
      );
    }
  }

  private assertGuestCurrent(guest: ActiveGuest): void {
    if (!this.isGuestCurrent(guest)) {
      void this.destroyGuest(guest).catch(() => undefined);
      throw new BrowserGuestError(
        "BROWSER_LEASE_INVALID",
        "The Browser Guest Profile has changed.",
      );
    }
  }

  private isGuestCurrent(guest: ActiveGuest): boolean {
    const current = this.options.getCurrentIdentity();
    return (
      this.guest === guest &&
      !this.options.window.isDestroyed() &&
      !this.options.window.webContents.isDestroyed() &&
      current !== null &&
      sameIdentity(guest.identity, current)
    );
  }

  private state(guest: ActiveGuest): BrowserGuestState {
    return {
      leaseId: guest.leaseId,
      url: guest.url,
      loading: guest.loading,
      ...(guest.errorCode === undefined ? {} : { errorCode: guest.errorCode }),
    };
  }

  private publish(guest: ActiveGuest): void {
    if (!this.isGuestCurrent(guest)) return;
    const errorCode =
      guest.errorCode !== undefined && SAFE_ERROR_CODES.has(guest.errorCode)
        ? guest.errorCode
        : undefined;
    this.options.sendState(guest.ownerId, {
      ...this.state(guest),
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  private destroyGuest(guest: ActiveGuest): Promise<void> {
    if (guest.closePromise !== undefined) return guest.closePromise;
    if (this.guest === guest) this.guest = undefined;
    const operation = this.performDestroyGuest(guest);
    guest.closePromise = operation;
    this.closingGuests.add(operation);
    void operation.then(
      () => this.closingGuests.delete(operation),
      () => undefined,
    );
    return operation;
  }

  private async performDestroyGuest(guest: ActiveGuest): Promise<void> {
    for (const removeListener of guest.listeners.splice(0)) removeListener();
    try {
      this.options.window.contentView.removeChildView(guest.view);
    } catch {
      // The owner window may already be closing.
    }
    try {
      await closeGuestWebContents(guest.view.webContents);
    } catch (error) {
      if (error instanceof BrowserGuestError) throw error;
      throw new BrowserGuestError(
        "BROWSER_GUEST_UNAVAILABLE",
        "The isolated Browser Guest could not be closed safely.",
      );
    }
  }
}

function closeGuestWebContents(contents: WebContentsView["webContents"]): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      contents.removeListener("destroyed", onDestroyed);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onDestroyed = () => finish();
    const timeout = setTimeout(() => {
      finish(
        new BrowserGuestError(
          "BROWSER_GUEST_UNAVAILABLE",
          "The isolated Browser Guest did not stop safely.",
        ),
      );
    }, GUEST_DESTROY_TIMEOUT_MS);
    contents.once("destroyed", onDestroyed);
    try {
      contents.close({ waitForBeforeUnload: false });
    } catch {
      if (contents.isDestroyed()) finish();
      else
        finish(
          new BrowserGuestError(
            "BROWSER_GUEST_UNAVAILABLE",
            "The isolated Browser Guest could not be closed safely.",
          ),
        );
    }
    if (contents.isDestroyed()) finish();
  });
}

function sameIdentity(left: BrowserGuestIdentity, right: BrowserGuestIdentity): boolean {
  return (
    left.userId === right.userId &&
    left.profileId === right.profileId &&
    left.generationId === right.generationId
  );
}
