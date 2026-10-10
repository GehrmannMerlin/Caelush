import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFile = promisify(execFileCallback);
const USER_ID_SCHEMA = z.uuid();
const PROFILE_ID_PATTERN = /^u_[0-9a-f]{64}$/u;
const PROFILE_DIRECTORIES = ["runs", "logs", "backups", "browser", "downloads", "run"] as const;
const SHARED_ACCESS_SIDS = ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"] as const;

const ProfileMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().regex(PROFILE_ID_PATTERN),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export interface ProfilePermissions {
  secureDirectory(directory: string): Promise<void>;
  verifyDirectory(directory: string): Promise<void>;
  secureFile(filePath: string): Promise<void>;
  verifyFile(filePath: string): Promise<void>;
}

export interface ProfileManagerOptions {
  /** Trusted `%LOCALAPPDATA%` value obtained by Main, never supplied by the Renderer. */
  readonly localAppDataDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly permissions: ProfilePermissions;
  readonly now?: () => Date;
}

export interface AccountProfile {
  readonly profileId: string;
  readonly rootDirectory: string;
  readonly databasePath: string;
  readonly runsDirectory: string;
  readonly logsDirectory: string;
  readonly backupsDirectory: string;
  readonly browserDirectory: string;
  readonly downloadsDirectory: string;
  readonly metadataPath: string;
}

export class ProfileManagerError extends Error {
  constructor(
    readonly code: "PROFILE_ID_INVALID" | "PROFILE_PATH_UNSAFE" | "PROFILE_METADATA_INVALID" | "PROFILE_PERMISSIONS_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ProfileManagerError";
  }
}

/**
 * Account User IDs are never used as paths. A domain-separated SHA-256 projection gives Main a
 * stable opaque directory name while keeping Profile selection derived exclusively from verified
 * AccountController state.
 */
export function profileIdForUser(userId: string): string {
  if (!USER_ID_SCHEMA.safeParse(userId).success) {
    throw new ProfileManagerError("PROFILE_ID_INVALID", "The account identity is invalid.");
  }
  return `u_${createHash("sha256")
    .update("caelush-desktop-profile-v1\0", "utf8")
    .update(userId.toLowerCase(), "utf8")
    .digest("hex")}`;
}

export class ProfileManager {
  private readonly localAppDataDirectory: string;
  private readonly profileRootDirectory: string;
  private readonly sharedRootDirectory: string;
  private readonly platform: NodeJS.Platform;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ProfileManagerOptions) {
    this.platform = options.platform ?? process.platform;
    if (options.localAppDataDirectory.trim().length === 0) {
      throw new ProfileManagerError("PROFILE_PATH_UNSAFE", "The local profile root is invalid.");
    }
    this.localAppDataDirectory = path.resolve(options.localAppDataDirectory);
    this.profileRootDirectory = path.join(this.localAppDataDirectory, "Caelush");
    this.sharedRootDirectory = path.join(this.profileRootDirectory, "shared");
    if (this.platform === "win32" && !path.win32.isAbsolute(this.localAppDataDirectory)) {
      throw new ProfileManagerError("PROFILE_PATH_UNSAFE", "The local profile root is invalid.");
    }
  }

  selectForUser(userId: string): Promise<AccountProfile> {
    return this.exclusive(async () => {
      const profileId = profileIdForUser(userId);
      await this.ensureLayout();
      const profilesDirectory = path.join(this.profileRootDirectory, "profiles");
      const profileDirectory = path.join(profilesDirectory, profileId);
      assertContained(profilesDirectory, profileDirectory, this.platform);

      const profileCreated = await ensureChildDirectory(
        profilesDirectory,
        profileId,
        this.platform,
      );
      await this.options.permissions.secureDirectory(profileDirectory);
      await this.options.permissions.verifyDirectory(profileDirectory);
      const dataDirectories = Object.fromEntries(
        PROFILE_DIRECTORIES.map((name) => [name, path.join(profileDirectory, name)]),
      ) as Record<(typeof PROFILE_DIRECTORIES)[number], string>;
      for (const directory of Object.values(dataDirectories)) {
        await ensureChildDirectory(profileDirectory, path.basename(directory), this.platform);
        await this.options.permissions.secureDirectory(directory);
        await this.options.permissions.verifyDirectory(directory);
      }

      const databasePath = path.join(profileDirectory, "caelush.db");
      assertContained(profileDirectory, databasePath, this.platform);
      await verifyOptionalDatabase(databasePath, this.options.permissions);

      const metadataPath = path.join(profileDirectory, "profile.json");
      assertContained(profileDirectory, metadataPath, this.platform);
      const metadata = await readProfileMetadata(metadataPath, profileCreated);
      if (metadata === null) {
        const createdAt = (this.options.now?.() ?? new Date()).toISOString();
        const next = ProfileMetadataSchema.parse({ schemaVersion: 1, profileId, createdAt });
        const file = await open(metadataPath, "wx", 0o600).catch((error: unknown) => {
          if (isFsError(error) && error.code === "EEXIST") {
            throw new ProfileManagerError(
              "PROFILE_METADATA_INVALID",
              "The account profile could not be initialized safely.",
            );
          }
          throw error;
        });
        try {
          await file.writeFile(JSON.stringify(next), "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      }
      await this.options.permissions.secureFile(metadataPath);
      await this.options.permissions.verifyFile(metadataPath);
      const confirmed = await readProfileMetadata(metadataPath, true);
      if (confirmed === null || confirmed.profileId !== profileId) {
        throw new ProfileManagerError(
          "PROFILE_METADATA_INVALID",
          "The account profile metadata does not match its owner.",
        );
      }

      return Object.freeze({
        profileId,
        rootDirectory: profileDirectory,
        databasePath,
        runsDirectory: dataDirectories.runs,
        logsDirectory: dataDirectories.logs,
        backupsDirectory: dataDirectories.backups,
        browserDirectory: dataDirectories.browser,
        downloadsDirectory: dataDirectories.downloads,
        metadataPath,
      });
    });
  }

  private async ensureLayout(): Promise<void> {
    await assertExistingDirectory(this.localAppDataDirectory, this.platform);
    await ensureChildDirectory(this.localAppDataDirectory, "Caelush", this.platform);
    await this.options.permissions.secureDirectory(this.profileRootDirectory);
    await this.options.permissions.verifyDirectory(this.profileRootDirectory);
    const profilesDirectory = path.join(this.profileRootDirectory, "profiles");
    const sharedDirectory = path.join(this.profileRootDirectory, "shared");
    const sharedLogsDirectory = path.join(sharedDirectory, "logs");
    for (const directory of [profilesDirectory, sharedDirectory, sharedLogsDirectory]) {
      const parent = path.dirname(directory);
      await ensureChildDirectory(parent, path.basename(directory), this.platform);
      await this.options.permissions.secureDirectory(directory);
      await this.options.permissions.verifyDirectory(directory);
    }
    for (const name of ["updates", "migration"] as const) {
      const directory = path.join(sharedDirectory, name);
      await ensureChildDirectory(sharedDirectory, name, this.platform);
      await this.options.permissions.secureDirectory(directory);
      await this.options.permissions.verifyDirectory(directory);
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

/** Windows ACL enforcement is explicit. The current user's SID is resolved by the OS and all
 * managed profile entries are protected from inherited access by other Windows users. */
export class WindowsProfilePermissions implements ProfilePermissions {
  private userSidPromise: Promise<string> | undefined;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async secureDirectory(directory: string): Promise<void> {
    this.assertWindows();
    const sid = await this.currentUserSid();
    try {
      await this.runIcacls([
        directory,
        "/inheritance:r",
        "/remove:g",
        ...SHARED_ACCESS_SIDS.map((value) => `*${value}`),
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "/C",
      ]);
    } catch {
      throw permissionError();
    }
  }

  async verifyDirectory(directory: string): Promise<void> {
    await this.verify(directory, true);
  }

  async secureFile(filePath: string): Promise<void> {
    this.assertWindows();
    const sid = await this.currentUserSid();
    try {
      await this.runIcacls([
        filePath,
        "/inheritance:r",
        "/remove:g",
        ...SHARED_ACCESS_SIDS.map((value) => `*${value}`),
        "/grant:r",
        `*${sid}:F`,
        "/C",
      ]);
    } catch {
      throw permissionError();
    }
  }

  async verifyFile(filePath: string): Promise<void> {
    await this.verify(filePath, false);
  }

  private async verify(value: string, directory: boolean): Promise<void> {
    this.assertWindows();
    const sid = await this.currentUserSid();
    try {
      const metadata = await lstat(value);
      if (
        metadata.isSymbolicLink() ||
        (directory ? !metadata.isDirectory() : !metadata.isFile())
      ) {
        throw permissionError();
      }
      await this.runIcacls([value, "/verify", "/C"]);
      const aclSnapshot = path.join(tmpdir(), `caelush-profile-acl-${randomUUID()}.tmp`);
      try {
        await this.runIcacls([value, "/save", aclSnapshot, "/C"]);
        const snapshotMetadata = await lstat(aclSnapshot);
        if (
          snapshotMetadata.isSymbolicLink() ||
          !snapshotMetadata.isFile() ||
          snapshotMetadata.size > 64 * 1024
        ) {
          throw permissionError();
        }
        const encodedSnapshot = await readFile(aclSnapshot);
        const snapshot = decodeWindowsAclSnapshot(encodedSnapshot);
        verifyPrivateWindowsAcl(snapshot, sid);
      } finally {
        await rm(aclSnapshot, { force: true });
      }
    } catch {
      throw permissionError();
    }
  }

  private async currentUserSid(): Promise<string> {
    this.userSidPromise ??= (async () => {
      const windowsDirectory = this.environment.SystemRoot ?? "C:\\Windows";
      const executable = path.join(windowsDirectory, "System32", "whoami.exe");
      const { stdout } = await execFile(executable, ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      });
      const sid = stdout.match(/S-1-(?:[0-9]+-)+[0-9]+/u)?.[0];
      if (sid === undefined) throw permissionError();
      return sid;
    })();
    return this.userSidPromise;
  }

  private async runIcacls(args: readonly string[]): Promise<string> {
    const windowsDirectory = this.environment.SystemRoot ?? "C:\\Windows";
    const executable = path.join(windowsDirectory, "System32", "icacls.exe");
    const { stdout, stderr } = await execFile(executable, [...args], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return `${stdout}\n${stderr}`;
  }

  private assertWindows(): void {
    if (this.platform !== "win32") throw permissionError();
  }
}

function decodeWindowsAclSnapshot(value: Buffer): string {
  if (value.byteLength < 2 || value.byteLength % 2 !== 0) throw permissionError();
  const snapshot = value.toString("utf16le").replace(/^\uFEFF/u, "");
  if (snapshot.includes("\uFFFD")) throw permissionError();
  return snapshot;
}

/** Verify the SID-based ACL snapshot produced by `icacls /save`, whose SDDL is locale-neutral. */
function verifyPrivateWindowsAcl(snapshot: string, userSid: string): void {
  const daclLine = snapshot
    .split(/\r?\n/u)
    .find((line) => /^D:(?:(?:P|AI|AR))*\(/u.test(line));
  const dacl = daclLine?.match(/^D:(?:(?:P|AI|AR))*((?:\([^()]+\))+)/u)?.[1];
  if (dacl === undefined) throw permissionError();

  const entries = [...dacl.matchAll(/\(([^()]+)\)/gu)].map((match) => {
    const fields = match[1]?.split(";") ?? [];
    if (fields.length !== 6) throw permissionError();
    return {
      access: fields[0],
      rights: fields[2],
      sid: fields[5],
    };
  });
  const isFullControl = (rights: string | undefined) =>
    rights === "FA" || rights === "0x10000000";
  const userFullControl = entries.some(
    (entry) => entry.access === "A" && entry.sid === userSid && isFullControl(entry.rights),
  );
  const unsafeAccess = entries.some(
    (entry) =>
      entry.access === "D" ||
      (entry.access === "A" && entry.rights !== "" && entry.sid !== userSid),
  );
  if (!userFullControl || unsafeAccess) throw permissionError();
}

async function readProfileMetadata(
  metadataPath: string,
  directoryWasCreated: boolean,
): Promise<z.infer<typeof ProfileMetadataSchema> | null> {
  try {
    const metadata = await lstat(metadataPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || metadata.size > 4096) {
      throw metadataError();
    }
    const parsed = ProfileMetadataSchema.safeParse(JSON.parse(await readFile(metadataPath, "utf8")));
    if (!parsed.success) throw metadataError();
    return parsed.data;
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT" && directoryWasCreated) return null;
    if (error instanceof ProfileManagerError) throw error;
    throw metadataError();
  }
}

async function verifyOptionalDatabase(
  databasePath: string,
  permissions: ProfilePermissions,
): Promise<void> {
  try {
    const metadata = await lstat(databasePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw unsafePathError();
    }
    await permissions.secureFile(databasePath);
    await permissions.verifyFile(databasePath);
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return;
    if (error instanceof ProfileManagerError) throw error;
    throw unsafePathError();
  }
}

async function ensureChildDirectory(
  parent: string,
  childName: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (childName.length === 0 || childName === "." || childName === ".." || /[\\/]/u.test(childName)) {
    throw unsafePathError();
  }
  await assertExistingDirectory(parent, platform);
  const childPath = path.join(parent, childName);
  assertContained(parent, childPath, platform);
  let created = false;
  try {
    await mkdir(childPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isFsError(error) || error.code !== "EEXIST") throw unsafePathError();
  }
  await assertExistingDirectory(childPath, platform);
  return created;
}

async function assertExistingDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unsafePathError();
    const canonical = await realpath(directory);
    if (!samePath(canonical, path.resolve(directory), platform)) throw unsafePathError();
  } catch (error) {
    if (error instanceof ProfileManagerError) throw error;
    throw unsafePathError();
  }
}

function assertContained(parent: string, target: string, platform: NodeJS.Platform): void {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    (platform === "win32" && path.win32.parse(parent).root.toLowerCase() !== path.win32.parse(target).root.toLowerCase())
  ) {
    throw unsafePathError();
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const normalized = path.resolve(value).replace(/[\\/]+$/u, "");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isFsError(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value;
}

function unsafePathError(): ProfileManagerError {
  return new ProfileManagerError(
    "PROFILE_PATH_UNSAFE",
    "The account profile path is unsafe or escapes its allowed directory.",
  );
}

function metadataError(): ProfileManagerError {
  return new ProfileManagerError(
    "PROFILE_METADATA_INVALID",
    "The account profile metadata is invalid or does not match its owner.",
  );
}

function permissionError(): ProfileManagerError {
  return new ProfileManagerError(
    "PROFILE_PERMISSIONS_INVALID",
    "The account profile permissions could not be verified for this Windows user.",
  );
}
