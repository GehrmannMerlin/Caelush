import { createHash } from "node:crypto";
import { open, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertSafePath,
  BrowserUpdateSnapshotSchema,
  type BrowserUpdateSnapshot,
} from "./state-store.js";
import { DesktopUpdateError } from "./error.js";

const SnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    profileId: z.string().regex(/^u_[0-9a-f]{64}$/),
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    vaultDigest: z.string().regex(/^[a-f0-9]{64}$/),
    fileCount: z.number().int().nonnegative().max(100000),
  })
  .strict();
const RETAINED_ENTRIES = new Set([
  "caelush.db",
  "caelush.db-wal",
  "profile.json",
  "runs",
  "run",
  "backups",
  "private-replay-keys",
]);
/** Agent/vault snapshot after safe shutdown. Browser files are locked until Electron exits;
 * the verified handoff takes their separate snapshot after exit, before NSIS. */
export async function captureUpdateProfile(
  profileRoot: string | null,
  vaultPath: string,
): Promise<string | null> {
  if (!profileRoot) return null;
  const profileId = path.basename(profileRoot);
  if (!/^u_[0-9a-f]{64}$/.test(profileId)) throw rejected();
  const snapshot = await digestProfile(profileRoot);
  return JSON.stringify({
    schemaVersion: 2,
    profileId,
    profileDigest: snapshot.digest,
    fileCount: snapshot.count,
    vaultDigest: await digestFile(vaultPath),
  });
}
export async function verifyUpdateProfile(
  snapshot: string | null,
  localAppData: string,
  vaultPath: string,
  browserSnapshot?: BrowserUpdateSnapshot | null,
): Promise<void> {
  if (snapshot === null) return;
  const saved = SnapshotSchema.parse(JSON.parse(snapshot));
  const root = path.join(localAppData, "Caelush", "profiles", saved.profileId);
  const current = await digestProfile(root);
  const savedBrowser = BrowserUpdateSnapshotSchema.parse(browserSnapshot);
  const browser = await digestBrowserProfile(path.join(root, "browser"));
  if (
    current.digest !== saved.profileDigest ||
    current.count !== saved.fileCount ||
    (await digestFile(vaultPath)) !== saved.vaultDigest ||
    browser.digest !== savedBrowser.digest ||
    browser.fileCount !== savedBrowser.fileCount
  )
    throw rejected();
}
/** Must match the fixed handoff's ordinal path / size / SHA-256 stream format. */
export async function digestBrowserProfile(root: string): Promise<BrowserUpdateSnapshot> {
  const result = await digestProfile(root, false);
  return { digest: result.digest, fileCount: result.count };
}
async function digestProfile(root: string, filterRoot = true) {
  await assertSafePath(root, true);
  const hash = createHash("sha256");
  let count = 0;
  async function walk(directory: string, relative: string) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (filterRoot && relative === "" && !RETAINED_ENTRIES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw rejected();
      if (metadata.isDirectory()) {
        await assertSafePath(target, true);
        await walk(target, rel);
      } else if (metadata.isFile()) {
        if (++count > 100000) throw rejected();
        hash.update(`${rel}\0${metadata.size}\0${await digestFile(target)}\n`);
      } else throw rejected();
    }
  }
  await walk(root, "");
  return { digest: hash.digest("hex"), count };
}
async function digestFile(file: string): Promise<string> {
  await assertSafePath(file, false);
  const handle = await open(file, "r");
  try {
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
function rejected() {
  return new DesktopUpdateError(
    "UPDATE_PROFILE_VERIFICATION_FAILED",
    "The preserved Profile, replay, browser, backup or encrypted vault failed post-install verification.",
  );
}
