import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts",
  timeout: 30_000,
  use: {
    browserName: "chromium",
  },
});
