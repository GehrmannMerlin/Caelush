import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountProfileUpdateInputSchema } from "../../src/main/cloud/schemas.js";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));

const entry = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccountProfileScreen } from "./src/renderer/components/account-profile-screen.tsx";

const profile = {
  displayName: "Crop test",
  email: "crop@example.test",
  emailVerified: true,
  avatarRevision: null,
  avatarBytes: null,
  updatedAt: "2026-10-15T00:00:00Z",
  canEdit: true,
};

window.avatarTest = { saved: null };
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AccountProfileScreen
      profile={profile}
      loading={false}
      online={true}
      busy={false}
      loadError={null}
      currentPassword=""
      newPassword=""
      setCurrentPassword={() => {}}
      setNewPassword={() => {}}
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
        return profile;
      }}
      onChangePassword={(event) => event.preventDefault()}
    />
  </StrictMode>,
);
`;

// The main CI check job installs Chromium; other environments can run the
// non-browser suite without downloading a browser as a test side effect.
describe.skipIf(!existsSync(chromium.executablePath()))("account avatar cropping", () => {
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
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    bundle = output.outputFiles[0]!.text;
    styles = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function selectImage(width: number, height: number, cached: boolean) {
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: styles });
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
    await page.addScriptTag({ content: bundle });
    await page.getByRole("button", { name: "选择图片", exact: true }).click();
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
    await page.getByRole("img", { name: "头像预览", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect
      .poll(() => page.evaluate("window.avatarTest.saved"))
      .toMatchObject({ displayName: "Crop test", removeAvatar: false });
    return page.evaluate("window.avatarTest.saved");
  }

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
    await page.getByRole("textbox", { name: "展示名", exact: true }).fill("霜华");
    const confirm = page.getByRole("button", { name: "使用此头像", exact: true });
    await expect.poll(() => confirm.isEnabled(), { timeout: 2_000 }).toBe(true);
    await confirm.click();
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect.poll(() => page.evaluate("window.avatarTest.saved")).not.toBeNull();
    const saved = await page.evaluate("window.avatarTest.saved");

    expect(
      AccountProfileUpdateInputSchema.safeParse({
        ...saved,
        avatar: { ...saved.avatar, bytes: new Uint8Array(saved.avatar.bytes) },
      }).success,
    ).toBe(true);
    expect(saved.displayName).toBe("霜华");
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
