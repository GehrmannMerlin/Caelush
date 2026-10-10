import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const browserHarness = vi.hoisted(() => ({
  preferences: undefined as Record<string, unknown> | undefined,
  views: [] as Array<{
    webContents: EventEmitter & Record<string, unknown>;
    bounds?: unknown;
    visible?: boolean;
  }>,
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWebContentsView {
    readonly webContents: EventEmitter & Record<string, unknown>;
    bounds?: unknown;
    visible?: boolean;
    constructor(options: { webPreferences: Record<string, unknown> }) {
      browserHarness.preferences = options.webPreferences;
      const contents = new EventEmitter() as EventEmitter & Record<string, unknown>;
      contents.id = 42;
      let destroyed = false;
      contents.isDestroyed = vi.fn(() => destroyed);
      contents.on("destroyed", () => {
        destroyed = true;
      });
      contents.close = vi.fn(() => setImmediate(() => contents.emit("destroyed")));
      contents.loadURL = vi.fn(async (url: string) => {
        contents.url = url;
        contents.emit("did-navigate", {}, url);
      });
      contents.reload = vi.fn();
      contents.stop = vi.fn();
      contents.setWindowOpenHandler = vi.fn(() => undefined);
      contents.navigationHistory = {
        canGoBack: () => true,
        canGoForward: () => true,
        goBack: vi.fn(),
        goForward: vi.fn(),
      };
      this.webContents = contents;
      browserHarness.views.push(this as never);
    }
    setVisible(visible: boolean) {
      this.visible = visible;
    }
    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }
  }
  return { session: { fromPath: vi.fn() }, WebContentsView: MockWebContentsView };
});

import { BrowserGuestManager } from "../../src/main/browser/guest-manager.js";

const guestViews = browserHarness.views;

afterEach(() => {
  browserHarness.preferences = undefined;
  browserHarness.views.splice(0);
});

function fixture() {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { id: 100, isDestroyed: () => false },
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    getContentSize: () => [1200, 800] as const,
  });
  const session = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  });
  const identity = {
    userId: "8d5cc9cb-f70d-4f5f-9d95-69c8e8eb8857",
    profileId: `u_${"a".repeat(64)}`,
    generationId: "9f16de4b-87a8-4f34-9504-a9a55e4f3d32",
    profile: { profileId: `u_${"a".repeat(64)}`, browserDirectory: "C:\\Profiles\\a\\browser" },
  };
  let activeIdentity: typeof identity | null = identity;
  const sessionFromPath = vi.fn(() => session);
  const manager = new BrowserGuestManager({
    window: window as never,
    getCurrentIdentity: () => activeIdentity as never,
    sendState: vi.fn(),
    sessionFromPath: sessionFromPath as never,
    policy: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
  });
  return {
    window,
    session,
    identity,
    sessionFromPath,
    manager,
    setIdentity(value: typeof identity | null) {
      activeIdentity = value;
    },
  };
}

const bounds = { x: 800, y: 50, width: 350, height: 700 };

describe("Main-owned Browser Guest", () => {
  it("creates a hardened WebContentsView in the authorized Profile session", async () => {
    const test = fixture();
    const state = await test.manager.createLease(100, bounds);

    expect(test.sessionFromPath).toHaveBeenCalledWith(test.identity.profile.browserDirectory);
    expect(browserHarness.preferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
    });
    expect(browserHarness.preferences).not.toHaveProperty("preload");
    expect(test.window.contentView.addChildView).toHaveBeenCalledOnce();
    expect(state.leaseId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(guestViews[0]?.visible).toBe(true);
    await test.manager.closeAll();
    test.manager.dispose();
  });

  it("loads public HTTPS pages, rejects other schemes, and blocks popups and permissions", async () => {
    const test = fixture();
    const state = await test.manager.createLease(100, bounds);
    const view = guestViews[0]!;
    const windowOpenHandler = (view.webContents.setWindowOpenHandler as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as () => unknown;
    expect(windowOpenHandler()).toEqual({ action: "deny" });
    const permissionCheck = (test.session.setPermissionCheckHandler as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as () => boolean;
    expect(permissionCheck()).toBe(false);
    const requestHandler = (test.session.setPermissionRequestHandler as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as (
      _contents: unknown,
      _permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    let permissionGranted: boolean | undefined;
    requestHandler({}, "media", (granted) => {
      permissionGranted = granted;
    });
    expect(permissionGranted).toBe(false);

    await expect(
      test.manager.navigate(100, state.leaseId, "https://example.com/docs"),
    ).resolves.toMatchObject({ url: "https://example.com/docs" });
    await expect(
      test.manager.navigate(100, state.leaseId, "file:///C:/Windows/win.ini"),
    ).rejects.toMatchObject({ code: "BROWSER_URL_INVALID" });
    expect(view.webContents.loadURL).toHaveBeenCalledOnce();
    await test.manager.closeAll();
    test.manager.dispose();
  });

  it("rejects bounds outside the right-side panel and destroys the Guest on Profile change", async () => {
    const test = fixture();
    const state = await test.manager.createLease(100, bounds);
    expect(() =>
      test.manager.setBounds(100, state.leaseId, { x: 100, y: 0, width: 1000, height: 700 }),
    ).toThrowError(/right workspace panel/u);
    test.setIdentity({
      ...test.identity,
      profileId: `u_${"b".repeat(64)}`,
      generationId: "b49d99b2-76a5-4b9c-933d-4b94dc535ae2",
      profile: {
        ...test.identity.profile,
        profileId: `u_${"b".repeat(64)}`,
        browserDirectory: "C:\\Profiles\\b\\browser",
      },
    });
    expect(() => test.manager.getState(100, state.leaseId)).toThrowError(/Profile has changed/u);
    await test.manager.closeAll();
    expect(test.window.contentView.removeChildView).toHaveBeenCalledOnce();
    expect(guestViews[0]?.webContents.close as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(guestViews[0]?.webContents.isDestroyed()).toBe(true);
    await test.manager.closeAll();
  });

  it("does not accept another WebContents owner or a malformed lease ID", async () => {
    const test = fixture();
    const state = await test.manager.createLease(100, bounds);
    expect(() => test.manager.reload(101, state.leaseId)).toThrowError(/lease is invalid/u);
    expect(() => test.manager.reload(100, "renderer-id")).toThrowError(/lease is invalid/u);
    await test.manager.closeAll();
    test.manager.dispose();
  });
});
