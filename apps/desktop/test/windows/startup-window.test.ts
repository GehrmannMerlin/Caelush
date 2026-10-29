import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  navigation: vi.fn(),
  popup: vi.fn(),
  loadURL: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      fake.options = options;
    }
    webContents = { on: fake.navigation, setWindowOpenHandler: fake.popup };
    loadURL = fake.loadURL;
    isDestroyed() {
      return false;
    }
    destroy() {}
  },
}));
import { createStartupWindow } from "../../src/main/windows/startup-window.js";

describe("startup feedback", () => {
  it("shows a sandboxed status window without loading unverified app resources", () => {
    createStartupWindow();
    expect(fake.options.show).toBe(true);
    expect(fake.options.webPreferences).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    const url = fake.loadURL.mock.calls[0]?.[0] as string | undefined;
    expect(url).toMatch(/^data:text\/html/);
    expect(decodeURIComponent(url ?? "")).toContain("正在校验应用文件");
    const preventDefault = vi.fn();
    fake.navigation.mock.calls[0]?.[1]({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(fake.popup.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
  });
});
