import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, mkdir, open, rename, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  canonicalizePolicyJson,
  parsePolicyJson,
  type VerifiedUpdatePolicy,
} from "../../shared/signed-update-policy.mjs";
import type { ProfilePermissions } from "../profiles/profile-manager.js";
import { DesktopUpdateError } from "./error.js";

const RevisionSchema = z
  .object({
    product: z.literal("caelush"),
    platform: z.literal("windows"),
    architecture: z.literal("x64"),
    channel: z.enum(["dev", "beta", "stable"]),
    highestAcceptedRevision: z.number().int().positive().safe(),
    acceptedPayloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const PendingUpdateSchema = z
  .object({
    transactionId: z.uuid(),
    sourceVersion: z.string().max(256),
    targetVersion: z.string().max(256),
    step: z.enum([
      "READY",
      "HANDOFF_STARTED",
      "INSTALLER_EXITED",
      "POST_INSTALL_VERIFY_PENDING",
      "POST_INSTALL_PROFILE_VERIFIED",
      "COMPLETED",
      "FAILED",
    ]),
    responseJson: z.string().max(240000),
    installerName: z.string().regex(/^[0-9a-f-]{36}\.exe$/),
    profileSnapshot: z.string().max(240000).nullable(),
  })
  .strict();
export type PendingUpdateRecord = z.infer<typeof PendingUpdateSchema>;
export const BrowserUpdateSnapshotSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    fileCount: z.number().int().nonnegative().max(100000),
  })
  .strict();
export type BrowserUpdateSnapshot = z.infer<typeof BrowserUpdateSnapshotSchema>;
const StateSchema = z
  .object({
    schemaVersion: z.literal(1),
    revisions: z.array(RevisionSchema).max(3),
    pending: PendingUpdateSchema.nullable(),
  })
  .strict();
type State = z.infer<typeof StateSchema>;
export const InstallerReceiptSchema = z
  .object({
    transactionId: z.uuid(),
    status: z.enum(["INSTALLER_EXITED", "FAILED", "CANCELLED"]),
    exitCode: z.number().int().nullable(),
    installerPid: z.number().int().positive().nullable(),
    browserSnapshot: BrowserUpdateSnapshotSchema.nullable().optional(),
  })
  .strict();

export class UpdateStateStore {
  private state: State = { schemaVersion: 1, revisions: [], pending: null };
  private initialized = false;
  constructor(
    readonly root: string,
    readonly permissions: ProfilePermissions,
  ) {
    if (!path.isAbsolute(root)) throw unsafe();
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await ensureSafeDirectory(this.root);
    await this.permissions.secureDirectory(this.root);
    await this.permissions.verifyDirectory(this.root);
    const raw = await this.readJson("state.json");
    if (raw !== null) {
      const wrapper = z
        .object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), data: StateSchema })
        .strict()
        .parse(raw);
      if (
        digest(wrapper.data) !== wrapper.sha256 ||
        new Set(wrapper.data.revisions.map((r) => r.channel)).size !== wrapper.data.revisions.length
      )
        throw corrupt();
      this.state = wrapper.data;
    }
    this.initialized = true;
    // Orphan streams can never become installers after a crash. Only our generated names are removed.
    for (const name of await readdir(this.root))
      if (/^[0-9a-f-]{36}\.(part|tmp)$/.test(name)) {
        await this.assertFile(name);
        await rm(this.file(name));
      }
    for (const name of await readdir(this.root)) {
      if (
        /^[0-9a-f-]{36}\.exe$/.test(name) &&
        (name !== this.state.pending?.installerName || this.state.pending.step === "COMPLETED")
      ) {
        await this.assertFile(name);
        await rm(this.file(name));
      }
    }
  }
  accepted(channel: string): { revision: number; digestSha256: string } | undefined {
    const r = this.state.revisions.find((r) => r.channel === channel);
    return r
      ? { revision: r.highestAcceptedRevision, digestSha256: r.acceptedPayloadDigest }
      : undefined;
  }
  async accept(policy: VerifiedUpdatePolicy): Promise<void> {
    this.assertInitialized();
    const p = policy.payload;
    const previous = this.accepted(p.channel);
    if (previous && p.revision < previous.revision)
      throw new DesktopUpdateError(
        "POLICY_REVISION_ROLLBACK",
        "The update policy revision moved backwards.",
      );
    if (
      previous &&
      p.revision === previous.revision &&
      policy.digestSha256 !== previous.digestSha256
    )
      throw new DesktopUpdateError(
        "POLICY_REVISION_CONFLICT",
        "This revision has conflicting signed content.",
      );
    if (previous?.revision === p.revision) return;
    await this.commit({
      ...this.state,
      revisions: [
        ...this.state.revisions.filter((r) => r.channel !== p.channel),
        {
          product: "caelush",
          platform: "windows",
          architecture: "x64",
          channel: p.channel,
          highestAcceptedRevision: p.revision,
          acceptedPayloadDigest: policy.digestSha256,
        },
      ],
    });
  }
  pending(): PendingUpdateRecord | null {
    return this.state.pending ? structuredClone(this.state.pending) : null;
  }
  async setPending(pending: PendingUpdateRecord | null): Promise<void> {
    this.assertInitialized();
    await this.commit({ ...this.state, pending });
  }
  async readReceipt(id: string) {
    const raw = await this.readJson(`${id}.receipt.json`);
    return raw === null ? null : InstallerReceiptSchema.parse(raw);
  }
  async readHandoffAck(id: string): Promise<unknown | null> {
    return this.readJson(`${id}.ack.json`);
  }
  file(name: string): string {
    if (
      !/^(?:state\.json|[0-9a-f-]{36}\.(?:exe|part|tmp|receipt\.json|handoff\.json|ack\.json|go))$/.test(
        name,
      )
    )
      throw unsafe();
    return path.join(this.root, name);
  }
  async assertDirectory(): Promise<void> {
    await assertSafePath(this.root, true);
    await this.permissions.verifyDirectory(this.root);
  }
  async assertFile(name: string): Promise<void> {
    await this.assertDirectory();
    await assertSafePath(this.file(name), false);
    await this.permissions.verifyFile(this.file(name));
  }
  async atomicJson(name: string, data: unknown): Promise<void> {
    await this.assertDirectory();
    const destination = this.file(name);
    const tempName = `${randomUUID()}.tmp`;
    const temp = this.file(tempName);
    const bytes = Buffer.from(JSON.stringify(data));
    if (bytes.length > 900000) throw corrupt();
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.permissions.secureFile(temp);
      await this.permissions.verifyFile(temp);
      await this.assertDirectory();
      await rename(temp, destination);
      await this.assertFile(name);
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async commit(next: State) {
    StateSchema.parse(next);
    await this.atomicJson("state.json", { sha256: digest(next), data: next });
    this.state = next;
  }
  private assertInitialized() {
    if (!this.initialized) throw corrupt();
  }
  private async readJson(name: string): Promise<unknown | null> {
    try {
      await this.assertFile(name);
      const handle = await open(this.file(name), "r");
      try {
        const s = await handle.stat();
        if (s.size > 900000 || !s.isFile() || s.nlink !== 1) throw corrupt();
        return parsePolicyJson(
          new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()),
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return null;
      throw corrupt();
    }
  }
}
function digest(value: unknown) {
  return createHash("sha256").update(canonicalizePolicyJson(value)).digest("hex");
}
export async function assertSafePath(target: string, directory: boolean): Promise<void> {
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  const parts = resolved.slice(current.length).split(path.sep).filter(Boolean);
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const metadata = await lstat(current);
    if (
      metadata.isSymbolicLink() ||
      (i < parts.length - 1 || directory
        ? !metadata.isDirectory()
        : !metadata.isFile() || metadata.nlink !== 1)
    )
      throw unsafe();
    const canonical = await realpath(current);
    if (canonical.toLowerCase() !== current.toLowerCase()) throw unsafe();
  }
}
async function ensureSafeDirectory(target: string): Promise<void> {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (e) {
      if (!(typeof e === "object" && e !== null && "code" in e && e.code === "EEXIST")) throw e;
    }
    await assertSafePath(current, true);
  }
}
function unsafe() {
  return new DesktopUpdateError(
    "UPDATE_PATH_UNSAFE",
    "The protected update path or permissions could not be verified.",
  );
}
function corrupt() {
  return new DesktopUpdateError(
    "UPDATE_STATE_INVALID",
    "The persistent update security state cannot be recovered safely. It has not been reset.",
  );
}
