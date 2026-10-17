import { describe, expect, it, vi } from "vitest";
import type { AppearanceSnapshot, ThemePreference } from "@caelush/ui-theme";
import { createDesktopAppearanceController } from "../src/host/desktop-appearance.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(
  preference: ThemePreference,
  resolvedTheme: "light" | "dark",
  revision: number,
): AppearanceSnapshot {
  return Object.freeze({ preference, resolvedTheme, revision });
}

describe("Desktop appearance adapter", () => {
  it("reconciles the main-process theme during workbench startup", async () => {
    const light = snapshot("light", "light", 0);
    const dark = snapshot("dark", "dark", 7);
    const bridge = {
      capabilityVersion: 1 as const,
      initialSnapshot: light,
      getSnapshot: vi.fn(async () => dark),
      setPreference: vi.fn(async () => dark),
      subscribe: vi.fn(() => () => undefined),
    };
    const applyTheme = vi.fn();

    const controller = createDesktopAppearanceController(bridge, applyTheme);

    await vi.waitFor(() => expect(controller.getSnapshot()).toEqual(dark));
    expect(bridge.getSnapshot).toHaveBeenCalledOnce();
    expect(applyTheme).toHaveBeenNthCalledWith(1, "light");
    expect(applyTheme).toHaveBeenNthCalledWith(2, "dark");
    controller.dispose();
  });

  it("previews immediately and reconciles from the latest main-process snapshot", async () => {
    let publish: ((value: AppearanceSnapshot) => void) | undefined;
    let mainSnapshot = snapshot("light", "light", 0);
    const darkWrite = deferred<AppearanceSnapshot>();
    const lightWrite = deferred<AppearanceSnapshot>();
    const bridge = {
      capabilityVersion: 1 as const,
      initialSnapshot: mainSnapshot,
      getSnapshot: vi.fn(async () => mainSnapshot),
      setPreference: vi.fn((preference: ThemePreference) =>
        preference === "dark" ? darkWrite.promise : lightWrite.promise,
      ),
      subscribe: vi.fn((listener: (value: AppearanceSnapshot) => void) => {
        publish = listener;
        return () => undefined;
      }),
    };
    const applyTheme = vi.fn();
    const controller = createDesktopAppearanceController(bridge, applyTheme);
    const changes: AppearanceSnapshot[] = [];
    controller.subscribe((next) => changes.push(next));

    const darkRequest = controller.setPreference("dark");
    expect(controller.getSnapshot()).toMatchObject({ preference: "dark", resolvedTheme: "dark" });
    const lightRequest = controller.setPreference("light");
    expect(controller.getSnapshot()).toMatchObject({ preference: "light", resolvedTheme: "light" });

    mainSnapshot = snapshot("dark", "dark", 1);
    publish?.(mainSnapshot);
    expect(controller.getSnapshot()).toMatchObject({ preference: "light", resolvedTheme: "light" });

    darkWrite.resolve(mainSnapshot);
    await darkRequest;
    expect(controller.getSnapshot()).toMatchObject({ preference: "light", resolvedTheme: "light" });

    mainSnapshot = snapshot("light", "light", 2);
    lightWrite.resolve(mainSnapshot);
    await lightRequest;

    expect(bridge.getSnapshot).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ preference: "light", resolvedTheme: "light" });
    expect(changes[0]).toMatchObject({ preference: "dark", resolvedTheme: "dark" });
    expect(applyTheme).toHaveBeenCalledWith("dark");
    expect(applyTheme).toHaveBeenCalledWith("light");
    controller.dispose();
  });

  it("restores the committed Desktop snapshot if the latest write fails", async () => {
    const bridge = {
      capabilityVersion: 1 as const,
      initialSnapshot: snapshot("light", "light", 0),
      getSnapshot: vi.fn(async () => snapshot("light", "light", 0)),
      setPreference: vi.fn(async () => {
        throw new Error("private storage detail");
      }),
      subscribe: vi.fn(() => () => undefined),
    };
    const controller = createDesktopAppearanceController(bridge, vi.fn());

    await expect(controller.setPreference("dark")).rejects.toThrow("private storage detail");
    expect(bridge.getSnapshot).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ preference: "light", resolvedTheme: "light" });
    controller.dispose();
  });
});
