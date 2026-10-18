import {
  createWorkspaceId,
  type AttachmentDescriptor,
  type AttachmentOwner,
} from "@caelush/protocol";
import type { AttachmentUploadOptions } from "@caelush/client";
import { describe, expect, it, vi } from "vitest";
import {
  AttachmentManager,
  type AttachmentUploadClient,
} from "../src/application/attachment-manager.js";

const owner: AttachmentOwner = { kind: "WORKSPACE", workspaceId: createWorkspaceId() };

function file(name: string, content = "hello", type = "text/plain"): File {
  return Object.assign(new Blob([content], { type }), { name, lastModified: 1 }) as File;
}

function descriptor(name: string, byteLength: number): AttachmentDescriptor {
  return {
    artifactId: `att_${name.padEnd(16, "x")}` as AttachmentDescriptor["artifactId"],
    workspaceId: owner.workspaceId,
    name,
    mediaType: "text/plain",
    byteLength,
    sha256: "a".repeat(64),
    status: "READY",
    visualRequirement: "NOT_REQUIRED",
    processorVersion: "documents-v1",
  };
}

describe("AttachmentManager", () => {
  it("tracks real upload progress and reaches READY only after daemon processing", async () => {
    let reportProgress:
      ((progress: { loadedBytes: number; totalBytes: number }) => void) | undefined;
    let finish!: (value: AttachmentDescriptor) => void;
    const client: AttachmentUploadClient = {
      uploadAttachment: vi.fn((_blob, input) => {
        reportProgress = input.onProgress;
        return new Promise((resolve) => (finish = resolve));
      }),
    };
    const manager = new AttachmentManager(client);
    const task = manager.addFiles([file("notes.txt")], owner);
    const itemId = manager.getSnapshot(owner)[0]?.id;
    expect(manager.getSnapshot(owner)[0]?.status).toBe("UPLOADING");
    reportProgress?.({ loadedBytes: 3, totalBytes: 5 });
    expect(manager.getSnapshot(owner)[0]).toMatchObject({ loadedBytes: 3, status: "UPLOADING" });
    reportProgress?.({ loadedBytes: 5, totalBytes: 5 });
    expect(manager.getSnapshot(owner)[0]?.status).toBe("PREPROCESSING");
    finish(descriptor("notes.txt", 5));
    await task;
    expect(manager.getSnapshot(owner)[0]).toMatchObject({
      id: itemId,
      status: "READY",
      artifactId: descriptor("notes.txt", 5).artifactId,
    });
  });

  it("accepts selected files after StrictMode replays the manager effect", async () => {
    const uploadAttachment = vi.fn((_blob: Blob, input: AttachmentUploadOptions) => {
      return new Promise<AttachmentDescriptor>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    const manager = new AttachmentManager({ uploadAttachment });
    let changeCount = 0;

    manager.activate();
    let unsubscribe = manager.subscribe(() => {
      changeCount += 1;
    });
    unsubscribe();
    manager.dispose();
    manager.activate();
    unsubscribe = manager.subscribe(() => {
      changeCount += 1;
    });

    const task = manager.addFiles([file("selected.txt")], owner);
    expect(manager.getSnapshot(owner)).toHaveLength(1);
    expect(manager.getSnapshot(owner)[0]).toMatchObject({
      name: "selected.txt",
      status: "UPLOADING",
    });
    expect(changeCount).toBeGreaterThan(0);
    expect(uploadAttachment).toHaveBeenCalledOnce();

    manager.dispose();
    unsubscribe();
    await task;
  });

  it("keeps failed items retryable with the original file and stable local identity", async () => {
    const upload = vi
      .fn<AttachmentUploadClient["uploadAttachment"]>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(descriptor("notes.txt", 5));
    const manager = new AttachmentManager({ uploadAttachment: upload });
    await manager.addFiles([file("notes.txt")], owner);
    const original = manager.getSnapshot(owner)[0]!;
    expect(original.status).toBe("FAILED");
    await manager.retry(original.id);
    expect(manager.getSnapshot(owner)[0]).toMatchObject({ id: original.id, status: "READY" });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("scopes restored cards to their workspace or session owner", () => {
    const sessionOwner: AttachmentOwner = {
      kind: "SESSION",
      sessionId: "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b" as never,
    };
    const manager = new AttachmentManager({ uploadAttachment: vi.fn() });
    const restored = {
      artifactId: descriptor("notes.txt", 5).artifactId,
      name: "notes.txt",
      mediaType: "text/plain",
      byteLength: 5,
      visualRequirement: "NOT_REQUIRED" as const,
    };
    manager.restore(owner, [restored]);
    manager.restore(sessionOwner, [{ ...restored, artifactId: "att_zyxwvutsrqponmlk" as never }]);
    expect(manager.getSnapshot(owner)).toHaveLength(1);
    expect(manager.getSnapshot(sessionOwner)).toHaveLength(1);
    expect(manager.getSnapshot({ kind: "WORKSPACE", workspaceId: createWorkspaceId() })).toEqual(
      [],
    );
  });

  it("clears the queue after its message was accepted", async () => {
    const manager = new AttachmentManager({
      uploadAttachment: vi.fn().mockResolvedValue(descriptor("notes.txt", 5)),
    });
    await manager.addFiles([file("notes.txt")], owner);
    expect(manager.getSnapshot(owner)).toHaveLength(1);

    manager.clear(owner);

    expect(manager.getSnapshot(owner)).toEqual([]);
    expect(manager.getReadyAttachmentIds(owner)).toEqual([]);
  });

  it("rejects oversized and over-count selections before upload", async () => {
    const uploadAttachment = vi.fn().mockResolvedValue(descriptor("notes.txt", 5));
    const manager = new AttachmentManager({ uploadAttachment });
    const tooLarge = Object.assign(new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]), {
      name: "large.txt",
    }) as File;
    await manager.addFiles(
      [tooLarge, ...Array.from({ length: 10 }, (_, index) => file(`${index}.txt`))],
      owner,
    );
    expect(uploadAttachment).toHaveBeenCalledTimes(10);
    expect(manager.getSnapshot(owner)).toHaveLength(11);
    expect(manager.getSnapshot(owner).filter((item) => item.status === "FAILED")).toHaveLength(1);
  });
});
