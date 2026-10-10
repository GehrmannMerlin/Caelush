import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_MAGIC = Buffer.from("CAELUSH-DPAPI-V1\0", "ascii");
const MAX_CIPHERTEXT_BYTES = 1_048_576;
const MAX_CLEAR_BYTES = 768 * 1024;
const ACCOUNT_KEY_PATTERN = /^[A-Fa-f0-9_-]{32,128}$/;

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  /** Linux-only backend diagnostic; Windows DPAPI is verified by an actual round trip. */
  getSelectedStorageBackend?(): string;
  encryptStringAsync(value: string): Promise<Uint8Array>;
  decryptStringAsync(value: Uint8Array): Promise<string>;
}

export class VaultUnavailableError extends Error {
  constructor(message = "Windows secure credential storage is unavailable or damaged.") {
    super(message);
    this.name = "VaultUnavailableError";
  }
}

interface VaultDocument {
  readonly version: 1;
  readonly entries: Record<string, unknown>;
}

/**
 * Current-user DPAPI-protected app-private vault. This uses Electron safeStorage,
 * not Windows Credential Manager. DPAPI protects against other Windows users, but
 * does not isolate this application from malicious processes running as the same user.
 */
export class DpapiVault {
  private initialized = false;
  private backendVerified = false;
  private entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly storage: SafeStoragePort,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  initialize(): Promise<void> {
    return this.exclusive(async () => {
      await this.verifyWindowsEncryption();
      try {
        const existing = await lstat(this.filePath);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new VaultUnavailableError();
        const file = await readFile(this.filePath);
        if (file.byteLength <= FILE_MAGIC.byteLength || file.byteLength > MAX_CIPHERTEXT_BYTES) {
          throw new VaultUnavailableError();
        }
        if (!file.subarray(0, FILE_MAGIC.byteLength).equals(FILE_MAGIC)) {
          throw new VaultUnavailableError();
        }
        let plaintext: string;
        try {
          plaintext = await this.storage.decryptStringAsync(file.subarray(FILE_MAGIC.byteLength));
        } catch {
          throw new VaultUnavailableError();
        }
        const parsed: unknown = JSON.parse(plaintext);
        this.entries = validateDocument(parsed).entries;
      } catch (error) {
        if (isMissingFile(error)) {
          this.entries = Object.create(null) as Record<string, unknown>;
        } else if (error instanceof VaultUnavailableError) {
          throw error;
        } else {
          throw new VaultUnavailableError();
        }
      }
      this.backendVerified = true;
      this.initialized = true;
    });
  }

  get(accountKey: string): Promise<unknown | null> {
    return this.exclusive(async () => {
      this.assertReady();
      validateAccountKey(accountKey);
      const value = this.entries[accountKey];
      if (value === undefined) return null;
      return structuredClone(value);
    });
  }

  set(accountKey: string, value: unknown): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady();
      validateAccountKey(accountKey);
      const encoded = serializeValue(value);
      const next = { ...this.entries, [accountKey]: JSON.parse(encoded) as unknown };
      await this.persist(next);
      this.entries = next;
    });
  }

  delete(accountKey: string): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady();
      validateAccountKey(accountKey);
      if (!Object.hasOwn(this.entries, accountKey)) return;
      const next = { ...this.entries };
      delete next[accountKey];
      await this.persist(next);
      this.entries = next;
    });
  }

  clear(): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady();
      const next = Object.create(null) as Record<string, unknown>;
      await this.persist(next);
      this.entries = next;
    });
  }

  private async verifyWindowsEncryption(): Promise<void> {
    if (this.platform !== "win32" || !this.storage.isEncryptionAvailable()) {
      throw new VaultUnavailableError();
    }
    const challenge = `caelush-dpapi-probe-v1:${randomUUID()}`;
    try {
      const encrypted = await this.storage.encryptStringAsync(challenge);
      if ((await this.storage.decryptStringAsync(encrypted)) !== challenge) {
        throw new Error("Windows secure storage did not return the original challenge.");
      }
    } catch {
      throw new VaultUnavailableError();
    }
  }

  private assertReady(): void {
    if (!this.initialized || !this.backendVerified)
      throw new VaultUnavailableError("Secure credential storage has not initialized.");
    if (this.platform !== "win32" || !this.storage.isEncryptionAvailable()) {
      throw new VaultUnavailableError();
    }
  }

  private async persist(entries: Record<string, unknown>): Promise<void> {
    let cleartext: string;
    try {
      cleartext = JSON.stringify({ version: 1, entries } satisfies VaultDocument);
    } catch {
      throw new VaultUnavailableError("Credential data could not be encoded safely.");
    }
    if (Buffer.byteLength(cleartext, "utf8") > MAX_CLEAR_BYTES) {
      throw new VaultUnavailableError("Secure credential storage reached its size limit.");
    }
    let encrypted: Uint8Array;
    try {
      encrypted = await this.storage.encryptStringAsync(cleartext);
    } catch {
      throw new VaultUnavailableError();
    }
    const output = Buffer.concat([FILE_MAGIC, Buffer.from(encrypted)]);
    if (output.byteLength > MAX_CIPHERTEXT_BYTES) throw new VaultUnavailableError();
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, output, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new VaultUnavailableError("Secure credential storage could not be updated.");
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

function validateDocument(value: unknown): VaultDocument {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !isRecord(value.entries)
  ) {
    throw new VaultUnavailableError();
  }
  for (const [accountKey, entry] of Object.entries(value.entries)) {
    validateAccountKey(accountKey);
    serializeValue(entry);
  }
  return { version: 1, entries: value.entries };
}

function serializeValue(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new VaultUnavailableError("Credential data could not be encoded safely.");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_CLEAR_BYTES) {
    throw new VaultUnavailableError("Credential data could not be encoded safely.");
  }
  return serialized;
}

function validateAccountKey(value: string): void {
  if (!ACCOUNT_KEY_PATTERN.test(value)) {
    throw new VaultUnavailableError("Secure credential record key is malformed.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
