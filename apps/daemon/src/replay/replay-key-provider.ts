import { randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrivateReplayError } from "@caelush/agent";
import type { ReplayKey, ReplayKeyProvider } from "@caelush/security";
import { windowsDpapi } from "./windows-dpapi.js";

interface ProtectedKeyFile {
  version: 1;
  keyId: string;
  protectedKey: string;
}

/** Linux/other hosts must explicitly inject a persistent host secret provider. */
export function createHostReplayKeyProvider(options: {
  keyFile: string;
  platform?: NodeJS.Platform;
  injected?: ReplayKeyProvider;
}): ReplayKeyProvider {
  if (options.injected !== undefined) return options.injected;
  if ((options.platform ?? process.platform) === "win32")
    return createWindowsReplayKeyProvider(options.keyFile);
  return Object.freeze({
    current: async () => {
      throw new PrivateReplayError();
    },
    get: async () => undefined,
  });
}

/** Only DPAPI-protected bytes are persisted. File loss/corruption never regenerates a key on read. */
export function createWindowsReplayKeyProvider(keyFile: string): ReplayKeyProvider {
  const path = resolve(keyFile);
  async function read(): Promise<ProtectedKeyFile | undefined> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
        throw new PrivateReplayError();
      const file = await open(path, "r");
      try {
        // Bounded even if another writer replaces/grows the file between stat and read.
        const buffer = Buffer.alloc(16385);
        const result = await file.read(buffer, 0, buffer.length, 0);
        if (result.bytesRead > 16384) throw new PrivateReplayError();
        const parsed: unknown = JSON.parse(buffer.subarray(0, result.bytesRead).toString("utf8"));
        if (typeof parsed !== "object" || parsed === null) throw new PrivateReplayError();
        const candidate = parsed as Record<string, unknown>;
        if (
          Object.keys(candidate).sort().join(",") !== "keyId,protectedKey,version" ||
          candidate.version !== 1 ||
          typeof candidate.keyId !== "string" ||
          !/^[a-zA-Z0-9_.-]{1,128}$/.test(candidate.keyId) ||
          typeof candidate.protectedKey !== "string"
        )
          throw new PrivateReplayError();
        const decoded = Buffer.from(candidate.protectedKey, "base64");
        if (
          decoded.length === 0 ||
          decoded.length > 8192 ||
          decoded.toString("base64") !== candidate.protectedKey
        )
          throw new PrivateReplayError();
        return { version: 1, keyId: candidate.keyId, protectedKey: candidate.protectedKey };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new PrivateReplayError();
    }
  }

  async function unprotect(record: ProtectedKeyFile): Promise<ReplayKey> {
    const bytes = await windowsDpapi(
      "unprotect",
      record.keyId,
      Buffer.from(record.protectedKey, "base64"),
    );
    if (bytes.length !== 32) {
      bytes.fill(0);
      throw new PrivateReplayError();
    }
    return { keyId: record.keyId, bytes };
  }

  return Object.freeze({
    async current(): Promise<ReplayKey> {
      try {
        const existing = await read();
        if (existing !== undefined) return await unprotect(existing);
        if (process.platform !== "win32") throw new PrivateReplayError();
        const bytes = randomBytes(32);
        const keyId = randomUUID();
        let protectedKey: Buffer;
        try {
          protectedKey = await windowsDpapi("protect", keyId, bytes);
        } finally {
          bytes.fill(0);
        }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(
            JSON.stringify({ version: 1, keyId, protectedKey: protectedKey.toString("base64") }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          // Atomic create-if-absent; a concurrent process never overwrites a durable master key.
          try {
            await link(temporary, path);
          } catch (error) {
            if (!(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "EEXIST"
            ))
              throw error;
          }
        } finally {
          await unlink(temporary);
        }
        const saved = await read();
        if (saved === undefined) throw new PrivateReplayError();
        return await unprotect(saved);
      } catch {
        throw new PrivateReplayError();
      }
    },
    async get(keyId: string): Promise<ReplayKey | undefined> {
      try {
        const saved = await read();
        return saved === undefined || saved.keyId !== keyId ? undefined : await unprotect(saved);
      } catch {
        throw new PrivateReplayError();
      }
    },
  });
}
