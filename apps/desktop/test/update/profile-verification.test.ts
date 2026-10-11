import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  captureUpdateProfile,
  digestBrowserProfile,
  verifyUpdateProfile,
} from "../../src/main/update/profile-verification.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root).startsWith("caelush-d72-profile-")).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "caelush-d72-profile-"));
  roots.push(root);
  const profile = path.join(root, "Caelush", "profiles", `u_${"a".repeat(64)}`);
  const browser = path.join(profile, "browser");
  const cookies = path.join(browser, "Network", "Cookies");
  const database = path.join(profile, "caelush.db");
  const vault = path.join(root, "vault.bin");
  await mkdir(path.dirname(cookies), { recursive: true });
  await writeFile(cookies, "persistent-cookie");
  await writeFile(database, "durable-agent-history");
  await writeFile(vault, "encrypted-credential-vault");
  return { root, profile, browser, cookies, database, vault };
}
it("binds the pre-exit Agent/vault snapshot to the separate post-exit Browser snapshot", async () => {
  const f = await fixture();
  const snapshot = await captureUpdateProfile(f.profile, f.vault);
  expect(JSON.parse(snapshot!).schemaVersion).toBe(2);
  expect(JSON.parse(snapshot!).fileCount).toBe(1);
  const browser = await digestBrowserProfile(f.browser);
  expect(browser.fileCount).toBe(1);
  await expect(verifyUpdateProfile(snapshot, f.root, f.vault, browser)).resolves.toBeUndefined();
});
it.each(["cookies", "database", "vault"] as const)(
  "rejects changed retained data (%s)",
  async (name) => {
    const f = await fixture();
    const snapshot = await captureUpdateProfile(f.profile, f.vault);
    const browser = await digestBrowserProfile(f.browser);
    await writeFile(f[name], "changed");
    await expect(verifyUpdateProfile(snapshot, f.root, f.vault, browser)).rejects.toThrow();
  },
);
it("requires the handoff Browser snapshot for an active Profile", async () => {
  const f = await fixture();
  const snapshot = await captureUpdateProfile(f.profile, f.vault);
  await expect(verifyUpdateProfile(snapshot, f.root, f.vault)).rejects.toThrow();
});
