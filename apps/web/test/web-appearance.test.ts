import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const controllerUrl = new URL("../src/appearance/web-appearance.ts", import.meta.url);
const STORAGE_KEY = "caelush.appearance.v1";

type StorageEventValue = { readonly key: string | null; readonly newValue: string | null };

function createEnvironment(
  options: {
    readonly storedValue?: string | null;
    readonly systemDark?: boolean;
    readonly failReads?: boolean;
    readonly failWrites?: boolean;
  } = {},
) {
  let storedValue = options.storedValue ?? null;
  const storage = {
    getItem: vi.fn(() => {
      if (options.failReads) throw new Error("storage unavailable");
      return storedValue;
    }),
    setItem: vi.fn((_key: string, value: string) => {
      if (options.failWrites) throw new Error("storage unavailable");
      storedValue = value;
    }),
  };
  const mediaListeners = new Set<(event: { readonly matches: boolean }) => void>();
  const mediaQuery = {
    matches: options.systemDark ?? false,
    addEventListener: vi.fn((_type: "change", listener: (event: { matches: boolean }) => void) => {
      mediaListeners.add(listener);
    }),
    removeEventListener: vi.fn(
      (_type: "change", listener: (event: { matches: boolean }) => void) => {
        mediaListeners.delete(listener);
      },
    ),
  };
  const storageListeners = new Set<(event: StorageEventValue) => void>();
  const storageEvents = {
    addEventListener: vi.fn((_type: "storage", listener: (event: StorageEventValue) => void) => {
      storageListeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: "storage", listener: (event: StorageEventValue) => void) => {
      storageListeners.delete(listener);
    }),
  };
  const appliedThemes: string[] = [];
  return {
    storage,
    mediaQuery,
    storageEvents,
    appliedThemes,
    getStoredValue: () => storedValue,
    emitSystemTheme(isDark: boolean) {
      mediaQuery.matches = isDark;
      for (const listener of mediaListeners) listener({ matches: isDark });
    },
    emitStorage(event: StorageEventValue) {
      if (event.key === STORAGE_KEY) storedValue = event.newValue;
      for (const listener of storageListeners) listener(event);
    },
    async createController() {
      expect(existsSync(controllerUrl)).toBe(true);
      const { createWebAppearanceController } = await import(controllerUrl.href);
      return createWebAppearanceController({
        storage,
        mediaQuery,
        storageEvents,
        applyTheme: (theme: string) => appliedThemes.push(theme),
      });
    },
  };
}

describe("Web appearance controller", () => {
  it("defaults to light and reads a valid origin-local preference", async () => {
    const fresh = createEnvironment();
    const freshController = await fresh.createController();
    expect(freshController.getSnapshot()).toEqual({
      preference: "light",
      resolvedTheme: "light",
      revision: 0,
    });
    freshController.dispose();

    const stored = createEnvironment({ storedValue: '{"version":1,"preference":"dark"}' });
    const storedController = await stored.createController();
    expect(storedController.getSnapshot().preference).toBe("dark");
    expect(stored.appliedThemes).toEqual(["dark"]);
    storedController.dispose();
  });

  it.each([
    ["malformed JSON", "{"],
    ["unsupported version", '{"version":2,"preference":"dark"}'],
    ["invalid preference", '{"version":1,"preference":"sepia"}'],
  ])("falls back to light for %s", async (_label, storedValue) => {
    const environment = createEnvironment({ storedValue });
    const controller = await environment.createController();

    expect(controller.getSnapshot().preference).toBe("light");
    expect(controller.getSnapshot().resolvedTheme).toBe("light");
    controller.dispose();
  });

  it("resolves system preference immediately and follows OS changes only in system mode", async () => {
    const environment = createEnvironment({
      storedValue: '{"version":1,"preference":"system"}',
      systemDark: true,
    });
    const controller = await environment.createController();

    expect(controller.getSnapshot()).toEqual({
      preference: "system",
      resolvedTheme: "dark",
      revision: 0,
    });
    environment.emitSystemTheme(false);
    expect(controller.getSnapshot().resolvedTheme).toBe("light");
    const systemRevision = controller.getSnapshot().revision;
    await controller.setPreference("dark");
    environment.emitSystemTheme(true);
    expect(controller.getSnapshot()).toEqual({
      preference: "dark",
      resolvedTheme: "dark",
      revision: systemRevision + 1,
    });
    controller.dispose();
  });

  it("synchronizes same-origin storage writes and resets to light when removed", async () => {
    const environment = createEnvironment();
    const controller = await environment.createController();
    const listener = vi.fn();
    controller.subscribe(listener);

    environment.emitStorage({
      key: STORAGE_KEY,
      newValue: '{"version":1,"preference":"dark"}',
    });
    expect(controller.getSnapshot().preference).toBe("dark");
    environment.emitStorage({ key: STORAGE_KEY, newValue: null });
    expect(controller.getSnapshot().preference).toBe("light");
    expect(listener).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("keeps an applied preview and rejects when browser storage cannot save", async () => {
    const environment = createEnvironment({ failWrites: true });
    const controller = await environment.createController();

    await expect(controller.setPreference("dark")).rejects.toThrow("storage unavailable");
    expect(controller.getSnapshot().preference).toBe("dark");
    expect(environment.appliedThemes.at(-1)).toBe("dark");
    expect(environment.getStoredValue()).toBeNull();
    controller.dispose();
  });

  it("removes storage and system listeners on dispose", async () => {
    const environment = createEnvironment();
    const controller = await environment.createController();

    controller.dispose();

    expect(environment.storageEvents.removeEventListener).toHaveBeenCalledOnce();
    expect(environment.mediaQuery.removeEventListener).toHaveBeenCalledOnce();
    environment.emitStorage({
      key: STORAGE_KEY,
      newValue: '{"version":1,"preference":"dark"}',
    });
    expect(controller.getSnapshot().preference).toBe("light");
  });
});
