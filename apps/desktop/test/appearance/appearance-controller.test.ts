import { describe, expect, it, vi } from "vitest";
import {
  DesktopAppearanceController,
  type DesktopAppearanceNativeTheme,
} from "../../src/main/appearance/appearance-controller.js";
import type { ThemePreference } from "@caelush/ui-theme";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(
  initialPreference: ThemePreference = "light",
  systemTheme: "light" | "dark" = "light",
) {
  const listeners = new Set<() => void>();
  const store = {
    read: vi.fn(async () => initialPreference),
    write: vi.fn(async (_preference: ThemePreference) => undefined),
  };
  const nativeTheme: DesktopAppearanceNativeTheme = {
    themeSource: "system",
    get shouldUseDarkColors() {
      return systemTheme === "dark";
    },
    on: vi.fn((_event, listener) => listeners.add(listener)),
    removeListener: vi.fn((_event, listener) => listeners.delete(listener)),
  };
  return {
    controller: new DesktopAppearanceController({ store, nativeTheme }),
    store,
    nativeTheme,
    updateSystemTheme(next: "light" | "dark") {
      systemTheme = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("Desktop appearance controller", () => {
  it("tracks native system changes only while the system preference is selected", async () => {
    const test = fixture("system");
    await test.controller.initialize();
    expect(test.controller.getSnapshot()).toMatchObject({
      preference: "system",
      resolvedTheme: "light",
      revision: 0,
    });

    test.updateSystemTheme("dark");
    expect(test.controller.getSnapshot()).toMatchObject({
      preference: "system",
      resolvedTheme: "dark",
      revision: 1,
    });

    await test.controller.setPreference("light");
    test.updateSystemTheme("dark");
    expect(test.controller.getSnapshot()).toMatchObject({
      preference: "light",
      resolvedTheme: "light",
      revision: 2,
    });
    test.controller.dispose();
  });

  it("increments revisions only when the public snapshot changes", async () => {
    const test = fixture();
    await test.controller.initialize();

    await test.controller.setPreference("light");
    expect(test.controller.getSnapshot().revision).toBe(0);
    await test.controller.setPreference("dark");
    expect(test.controller.getSnapshot()).toMatchObject({
      preference: "dark",
      resolvedTheme: "dark",
      revision: 1,
    });
    test.updateSystemTheme("dark");
    expect(test.controller.getSnapshot().revision).toBe(1);
    test.controller.dispose();
  });

  it("serializes concurrent preference writes in arrival order", async () => {
    const test = fixture();
    const firstWrite = deferred();
    const writes: ThemePreference[] = [];
    test.store.write.mockImplementation(async (preference) => {
      writes.push(preference);
      if (writes.length === 1) await firstWrite.promise;
    });
    await test.controller.initialize();

    const first = test.controller.setPreference("dark");
    const second = test.controller.setPreference("light");
    await Promise.resolve();
    expect(writes).toEqual(["dark"]);
    firstWrite.resolve();
    await Promise.all([first, second]);

    expect(writes).toEqual(["dark", "light"]);
    expect(test.controller.getSnapshot()).toMatchObject({ preference: "light", revision: 2 });
    test.controller.dispose();
  });

  it("does not publish a preference whose durable write fails", async () => {
    const test = fixture();
    await test.controller.initialize();
    test.store.write.mockRejectedValue(new Error("disk unavailable"));

    await expect(test.controller.setPreference("dark")).rejects.toThrow("disk unavailable");
    expect(test.controller.getSnapshot()).toMatchObject({
      preference: "light",
      resolvedTheme: "light",
      revision: 0,
    });
    test.controller.dispose();
  });

  it("uses nativeTheme.themeSource and removes its OS listener on disposal", async () => {
    const test = fixture("system", "dark");
    await test.controller.initialize();
    expect(test.nativeTheme.themeSource).toBe("system");
    expect(test.controller.getSnapshot().resolvedTheme).toBe("dark");

    await test.controller.setPreference("light");
    expect(test.nativeTheme.themeSource).toBe("light");
    test.controller.dispose();
    expect(test.nativeTheme.removeListener).toHaveBeenCalledWith("updated", expect.any(Function));
  });
});
