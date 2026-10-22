import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountProfileUpdateInputSchema } from "../../src/main/cloud/schemas.js";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));

const entry = `
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountProfileScreen } from "./src/renderer/components/account-profile-screen.tsx";

const initialProfile = {
  displayName: "Crop test",
  email: "crop@example.test",
  emailVerified: true,
  avatarRevision: "avatar-v1",
  avatarBytes: null,
  updatedAt: "2026-10-15T00:00:00Z",
  canEdit: true,
};

window.avatarTest = {
  saved: null,
  calls: [],
  openedSession: null,
  openedWorkbench: false,
  openedModelSettings: false,
  managedDevices: false,
  loggedOut: false,
};

function TestHarness() {
  const [profile, setProfile] = useState(initialProfile);
  return (
    <AccountProfileScreen
      profile={profile}
      loading={false}
      online={true}
      busy={false}
      loadError={null}
      entitlements={[{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }]}
      profileCenterApi={{
        getSnapshot: async () => ({
          recentSessions: [
            {
              id: "ses_00000000-0000-7000-8000-000000000001",
              title: "修复登录流程",
              updatedAt: 1792026000000,
            },
          ],
          usage: {
            allTime: { successfulRequests: 21, totalTokens: 9600 },
            since: { successfulRequests: 3, totalTokens: 1200 },
          },
        }),
      }}
      onOpenSession={(sessionId) => (window.avatarTest.openedSession = sessionId)}
      onOpenWorkbench={() => (window.avatarTest.openedWorkbench = true)}
      onOpenModelSettings={() => (window.avatarTest.openedModelSettings = true)}
      onManageDevices={() => (window.avatarTest.managedDevices = true)}
      onLogout={() => (window.avatarTest.loggedOut = true)}
      onSelectAvatar={() => {
        const { base64, delay } = window.avatarFixture;
        const selected = {
          mimeType: "image/png",
          bytes: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
        };
        // Native file selection resolves outside the original React click event.
        return delay === null
          ? Promise.resolve(selected)
          : new Promise((resolve) => setTimeout(() => resolve(selected), delay));
      }}
      onSave={async (input) => {
        window.avatarTest.saved = {
          displayName: input.displayName,
          removeAvatar: input.removeAvatar,
          avatar: input.avatar && {
            bytes: Array.from(input.avatar.bytes),
            contentType: input.avatar.contentType,
            crop: input.avatar.crop,
          },
        };
        window.avatarTest.calls.push(window.avatarTest.saved);
        const updated = {
          ...profile,
          displayName: input.displayName,
          avatarRevision: input.removeAvatar
            ? null
            : input.avatar
              ? "avatar-v2"
              : profile.avatarRevision,
        };
        setProfile(updated);
        return updated;
      }}
    />
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <TestHarness />
  </StrictMode>,
);
`;

// The main CI check job installs Chromium; other environments can run the
// non-browser suite without downloading a browser as a test side effect.
describe.skipIf(!existsSync(chromium.executablePath()))("account profile editing", () => {
  let browser: Browser;
  let page: Page;
  let bundle: string;
  let styles: string;

  beforeAll(async () => {
    const output = await build({
      stdin: { contents: entry, resolveDir: desktopRoot, loader: "tsx" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      loader: { ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    bundle = output.outputFiles[0]!.text;
    styles = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(1_500);
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function mountProfile() {
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: styles });
    await page.addScriptTag({ content: bundle });
  }

  async function selectImage(width: number, height: number, cached: boolean) {
    await mountProfile();
    await page.evaluate(
      async ({ width, height, cached }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const source = canvas.toDataURL("image/png");
        if (cached) {
          const image = new Image();
          image.src = source;
          await image.decode();
        }
        Object.assign(window, {
          avatarFixture: { base64: source.split(",")[1], delay: cached ? 25 : null },
        });
      },
      { width, height, cached },
    );
    await page.locator(".profile-avatar-frame").hover();
    await page.getByRole("button", { name: "上传头像", exact: true }).click();
    await page.locator(".profile-crop-viewport img").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>(".profile-crop-viewport img");
      return image?.complete && image.naturalWidth > 0;
    });
  }

  async function confirmAndSave() {
    const confirm = page.getByRole("button", { name: "使用此头像", exact: true });
    await expect.poll(() => confirm.isEnabled(), { timeout: 2_000 }).toBe(true);
    await confirm.click();
    await expect.poll(() => page.evaluate("window.avatarTest.calls.length")).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate("window.avatarTest.saved"))
      .toMatchObject({ displayName: "Crop test", removeAvatar: false });
    return page.evaluate("window.avatarTest.saved");
  }

  it("keeps the profile identity but does not show password-change controls", async () => {
    await mountProfile();

    expect(await page.locator(".profile-card").isVisible()).toBe(true);
    expect(await page.getByText("crop@example.test", { exact: true }).isVisible()).toBe(true);
    expect(await page.locator(".password-panel").count()).toBe(0);
  });

  it("saves a display name when the inline editor loses focus", async () => {
    await mountProfile();

    await page.getByRole("button", { name: "编辑展示名：Crop test", exact: true }).click();
    await page.getByRole("textbox", { name: "展示名", exact: true }).fill("霜华");
    await page.locator("body").click({ position: { x: 1, y: 1 } });

    await expect
      .poll(() => page.evaluate("window.avatarTest.saved"))
      .toMatchObject({
        displayName: "霜华",
        removeAvatar: false,
      });
    expect(await page.evaluate("window.avatarTest.calls.length")).toBe(1);
  });

  it("renders the email address as read-only text", async () => {
    await mountProfile();

    expect(await page.getByText("crop@example.test", { exact: true }).isVisible()).toBe(true);
    expect(await page.locator("#profile-email").count()).toBe(0);
  });

  it("shows real recent work, provider usage, and the account entitlement without adding another identity layout", async () => {
    await mountProfile();

    await expect
      .poll(() => page.getByRole("button", { name: "继续会话：修复登录流程" }).isVisible())
      .toBe(true);
    expect(await page.getByText("1,200", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("9,600", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("Caelush Desktop", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("已启用", { exact: true }).isVisible()).toBe(true);

    const alignment = await page.evaluate(() => {
      const centerX = (selector: string) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return rect.left + rect.width / 2;
      };
      const stack = document.querySelector(".account-profile-stack")!.getBoundingClientRect();
      const section = document.querySelector(".account-center-section")!.getBoundingClientRect();
      return {
        avatar: centerX(".profile-avatar-frame"),
        displayName: centerX(".profile-name-button"),
        email: centerX(".profile-email"),
        contentLeft: stack.left,
        sectionLeft: section.left,
        contentWidth: stack.width,
        sectionWidth: section.width,
      };
    });
    expect(alignment.avatar).toBeCloseTo(alignment.displayName, 0);
    expect(alignment.displayName).toBeCloseTo(alignment.email, 0);
    expect(alignment.contentLeft).toBeCloseTo(alignment.sectionLeft, 0);
    expect(alignment.contentWidth).toBeCloseTo(alignment.sectionWidth, 0);
  });

  it("opens the selected session, model settings, device management, and account switching actions", async () => {
    await mountProfile();

    await page.getByRole("button", { name: "继续会话：修复登录流程" }).click();
    await page.getByRole("button", { name: /管理模型/u }).click();
    expect(await page.getByRole("dialog", { name: "设置" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "关闭设置" }).click();
    await page.getByRole("button", { name: /管理设备/u }).click();
    await page.locator(".account-center-row.is-danger").click();

    expect(await page.evaluate("window.avatarTest.openedSession")).toBe(
      "ses_00000000-0000-7000-8000-000000000001",
    );
    expect(await page.evaluate("window.avatarTest.managedDevices")).toBe(true);
    expect(await page.evaluate("window.avatarTest.loggedOut")).toBe(true);
  });

  it("keeps the aligned sections and right-side actions usable on a narrow window", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountProfile();

    const layout = await page.evaluate(() => {
      const stack = document.querySelector(".account-profile-stack")!.getBoundingClientRect();
      const section = document.querySelector(".account-center-section")!.getBoundingClientRect();
      return {
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        stackLeft: stack.left,
        sectionLeft: section.left,
        sectionRight: section.right,
      };
    });
    expect(layout.documentWidth).toBe(layout.viewportWidth);
    expect(layout.sectionLeft).toBeCloseTo(layout.stackLeft, 0);
    expect(layout.sectionRight).toBeLessThanOrEqual(layout.viewportWidth);
    expect(await page.getByRole("button", { name: /管理模型/u }).isVisible()).toBe(true);
  });

  it("shows avatar actions only while hovering the avatar", async () => {
    await mountProfile();
    const avatar = page.locator(".profile-avatar-frame");
    const overlay = page.locator(".profile-avatar-overlay");

    await expect.poll(() => overlay.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
    await avatar.hover();
    await expect.poll(() => overlay.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
    expect(await page.getByRole("button", { name: "上传头像", exact: true }).isVisible()).toBe(
      true,
    );
    expect(await page.getByRole("button", { name: "删除头像", exact: true }).isVisible()).toBe(
      true,
    );
    await page.mouse.move(1, 1);
    await expect.poll(() => overlay.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");
  });

  it("removes the avatar immediately after clicking the delete control", async () => {
    await mountProfile();
    await page.locator(".profile-avatar-frame").hover();
    await page.getByRole("button", { name: "删除头像", exact: true }).click();

    await expect.poll(() => page.evaluate("window.avatarTest.calls.length")).toBe(1);
    expect(await page.evaluate("window.avatarTest.saved")).toMatchObject({
      displayName: "Crop test",
      removeAvatar: true,
    });
  });

  it("confirms a cached image returned asynchronously by the file picker", async () => {
    await selectImage(400, 400, true);

    expect(await confirmAndSave()).toMatchObject({
      avatar: {
        contentType: "image/png",
        crop: { x: 0, y: 0, width: 1, height: 1 },
      },
    });
  });

  it("confirms a newly decoded image", async () => {
    await selectImage(400, 400, false);

    expect(await confirmAndSave()).toMatchObject({
      avatar: { crop: { x: 0, y: 0, width: 1, height: 1 } },
    });
  });

  it.each([
    { width: 117, height: 117, crop: { x: 0, y: 0, width: 1, height: 1 } },
    {
      width: 1258,
      height: 1244,
      crop: { x: 7 / 1258, y: 0, width: 1244 / 1258, height: 1 },
    },
    {
      width: 1244,
      height: 1258,
      crop: { x: 0, y: 7 / 1258, width: 1, height: 1244 / 1258 },
    },
  ])("submits an in-bounds crop for a $width x $height image", async ({ width, height, crop }) => {
    await selectImage(width, height, true);
    const confirm = page.getByRole("button", { name: "使用此头像", exact: true });
    await expect.poll(() => confirm.isEnabled(), { timeout: 2_000 }).toBe(true);
    await confirm.click();
    await expect.poll(() => page.evaluate("window.avatarTest.saved")).not.toBeNull();
    const saved = await page.evaluate("window.avatarTest.saved");

    expect(
      AccountProfileUpdateInputSchema.safeParse({
        ...saved,
        avatar: { ...saved.avatar, bytes: new Uint8Array(saved.avatar.bytes) },
      }).success,
    ).toBe(true);
    for (const coordinate of ["x", "y", "width", "height"] as const) {
      expect(saved.avatar.crop[coordinate]).toBeCloseTo(crop[coordinate], 12);
    }
  });

  it("keeps a zoomed rectangular image crop square in source pixels", async () => {
    await selectImage(800, 400, true);
    const confirm = page.getByRole("button", { name: "使用此头像", exact: true });
    await expect.poll(() => confirm.isEnabled(), { timeout: 2_000 }).toBe(true);
    await page.getByRole("slider").press("End");

    const saved = await confirmAndSave();
    expect(saved.avatar.crop.x).toBeCloseTo(5 / 12);
    expect(saved.avatar.crop.y).toBeCloseTo(1 / 3);
    expect(saved.avatar.crop.width).toBeCloseTo(1 / 6);
    expect(saved.avatar.crop.height).toBeCloseTo(1 / 3);
  });
});
