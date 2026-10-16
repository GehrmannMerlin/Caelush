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

    expect(bridge.getSnapshot).toHaveBeenCalledOnce();
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
    expect(bridge.getSnapshot).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ preference: "light", resolvedTheme: "light" });
    controller.dispose();
  });
});
