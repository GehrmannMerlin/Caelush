import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const ReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    cloudUserId: z.uuid(),
    profileId: z.string().regex(/^u_[0-9a-f]{64}$/u),
    state: z.enum(["IMPORT_STAGED", "DESTINATION_VERIFIED", "COMMITTED", "RECOVERY_BLOCKED"]),
    backupId: z.uuid(),
    sourceKind: z.enum(["DEFAULT_HOME", "CUSTOM_HOME"]),
    summary: z
      .object({
        workspaces: z.number().int().nonnegative().safe(),
        sessions: z.number().int().nonnegative().safe(),
        runs: z.number().int().nonnegative().safe(),
        messages: z.number().int().nonnegative().safe(),
        durableEvents: z.number().int().nonnegative().safe(),
        contextCheckpoints: z.number().int().nonnegative().safe(),
        toolExecutions: z.number().int().nonnegative().safe(),
        providerCredentials: z.number().int().nonnegative().safe(),
        modelSelections: z.number().int().nonnegative().safe(),
        privateReplayFiles: z.number().int().nonnegative().safe(),
        estimatedBytes: z.number().int().nonnegative().safe(),
      })
      .strict(),
    updatedAtMs: z.number().int().nonnegative().safe(),
  })
  .strict();

export type LegacyImportReceipt = z.infer<typeof ReceiptSchema>;

export async function readLegacyImportReceipt(
  backupsDirectory: string,
  cloudUserId: string,
  profileId: string,
): Promise<LegacyImportReceipt | undefined> {
  const receiptPath = path.join(backupsDirectory, "legacy-import.json");
  try {
    const metadata = await lstat(receiptPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size > 4096
    ) {
      throw new Error("receipt");
    }
    const parsed = ReceiptSchema.safeParse(JSON.parse(await readFile(receiptPath, "utf8")));
    if (
      !parsed.success ||
      parsed.data.cloudUserId !== cloudUserId ||
      parsed.data.profileId !== profileId
    ) {
      throw new Error("receipt");
    }
    return parsed.data;
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return undefined;
    throw new Error("The local data import needs protected recovery.");
  }
}

export async function writeLegacyImportReceipt(
  backupsDirectory: string,
  input: Omit<LegacyImportReceipt, "schemaVersion" | "updatedAtMs"> & {
    readonly updatedAtMs: number;
  },
): Promise<LegacyImportReceipt> {
  const receipt = ReceiptSchema.parse({ schemaVersion: 1, ...input });
  const receiptPath = path.join(backupsDirectory, "legacy-import.json");
  const tempPath = `${receiptPath}.${randomUUID()}.tmp`;
  await mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(tempPath, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    await rename(tempPath, receiptPath);
    return receipt;
  } catch {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error("The local data import state could not be saved safely.");
  }
}

function isFsError(value: unknown): value is NodeJS.ErrnoException {
  return value !== null && typeof value === "object" && "code" in value;
}
