import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AccountAvatarCachePort } from "./controller.js";

const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_ENCRYPTED_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;

export interface AvatarCacheEncryptionPort {
  encrypt(clearText: string): Promise<Uint8Array>;
  decrypt(cipherText: Uint8Array): Promise<string>;
}

export class DesktopAccountAvatarCache implements AccountAvatarCachePort {
  constructor(
    private readonly directory: string,
    private readonly encryption: AvatarCacheEncryptionPort,
  ) {}

  async read(userId: string, revision: string): Promise<Uint8Array | null> {
    const path = this.avatarPath(userId, revision);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size < 16 || metadata.size > MAX_ENCRYPTED_AVATAR_BYTES) {
        await rm(path, { force: true });
        return null;
      }
      const file = await open(path, "r");
      try {
        const encrypted = new Uint8Array(await file.readFile());
        let encoded: string;
        try {
          encoded = await this.encryption.decrypt(encrypted);
        } catch {
          await rm(path, { force: true });
          return null;
        }
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded) {
          await rm(path, { force: true });
          return null;
        }
        if (!isWebp(bytes)) {
          await rm(path, { force: true });
          return null;
        }
        return new Uint8Array(bytes);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async write(userId: string, revision: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength < 12 || bytes.byteLength > MAX_AVATAR_BYTES || !isWebp(bytes)) {
      throw new Error("The avatar cache received an invalid image.");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.avatarPath(userId, revision);
    const encrypted = await this.encryption.encrypt(Buffer.from(bytes).toString("base64"));
    if (encrypted.byteLength > MAX_ENCRYPTED_AVATAR_BYTES) {
      throw new Error("The encrypted avatar exceeds the local cache limit.");
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(encrypted);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await this.prune(path);
  }

  async clear(userId: string): Promise<void> {
    const prefix = `${hash(userId)}-`;
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".webp"))
        .map((entry) => rm(join(this.directory, entry), { force: true })),
    );
  }

  private avatarPath(userId: string, revision: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ||
      revision.length < 1 ||
      revision.length > 64
    ) {
      throw new Error("The avatar cache key is invalid.");
    }
    return join(this.directory, `${hash(userId)}-${hash(revision)}.webp`);
  }

  private async prune(currentPath: string): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^[a-f0-9]{64}-[a-f0-9]{64}\.webp$/u.test(entry.name))
        .map(async (entry) => {
          const path = join(this.directory, entry.name);
          const metadata = await stat(path).catch(() => null);
          return metadata === null ? null : { path, modifiedAt: metadata.mtimeMs };
        }),
    );
    const ordered = files
      .filter((entry): entry is { path: string; modifiedAt: number } => entry !== null)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    const keep = new Set([
      currentPath,
      ...ordered.slice(0, MAX_CACHE_ENTRIES - 1).map((item) => item.path),
    ]);
    await Promise.all(
      ordered
        .filter((entry) => !keep.has(entry.path))
        .map((entry) => rm(entry.path, { force: true })),
    );
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
