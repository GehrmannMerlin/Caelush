import {
  AttachmentNameSchema,
  AttachmentOwnerSchema,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  type AttachmentDescriptor,
  type AttachmentDraftItem,
  type AttachmentId,
  type AttachmentOwner,
} from "@caelush/protocol";
import type { AttachmentUploadOptions } from "@caelush/client";
import { CaelushClientHttpError } from "@caelush/client";

export type AttachmentQueueStatus =
  "VALIDATING" | "UPLOADING" | "PREPROCESSING" | "READY" | "FAILED";

export interface AttachmentQueueItem {
  readonly id: string;
  readonly owner: AttachmentOwner;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly status: AttachmentQueueStatus;
  readonly loadedBytes: number;
  readonly totalBytes: number;
  readonly artifactId?: AttachmentId;
  readonly visualRequirement?: AttachmentDescriptor["visualRequirement"];
  readonly error?: string;
  readonly file?: File;
}

export interface AttachmentUploadClient {
  uploadAttachment(blob: Blob, input: AttachmentUploadOptions): Promise<AttachmentDescriptor>;
}

interface OwnerQueue {
  readonly owner: AttachmentOwner;
  items: AttachmentQueueItem[];
  snapshot: readonly AttachmentQueueItem[];
}

const EMPTY_QUEUE: readonly AttachmentQueueItem[] = Object.freeze([]);

export class AttachmentManager {
  private readonly queues = new Map<string, OwnerQueue>();
  private readonly uploads = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private nextLocalId = 0;
  private disposed = false;

  constructor(private readonly client: AttachmentUploadClient) {}

  getSnapshot(owner: AttachmentOwner): readonly AttachmentQueueItem[] {
    const queue = this.queues.get(ownerKey(owner));
    return queue?.snapshot ?? EMPTY_QUEUE;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getReadyAttachmentIds(owner: AttachmentOwner): readonly AttachmentId[] {
    return this.getSnapshot(owner).flatMap((item) =>
      (item.status === "READY" || item.status === "FAILED") && item.artifactId !== undefined
        ? [item.artifactId]
        : [],
    );
  }

  restore(
    owner: AttachmentOwner,
    attachments: readonly AttachmentDraftItem[],
    unavailableIds: readonly AttachmentId[] = [],
  ): void {
    if (this.disposed) return;
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    const key = ownerKey(parsedOwner);
    const queue = this.getOrCreateQueue(parsedOwner);
    if (queue.items.length > 0) return;
    const restoredItems: AttachmentQueueItem[] = attachments.map((attachment) => ({
      id: `restored:${attachment.artifactId}`,
      owner: parsedOwner,
      name: attachment.name,
      mediaType: attachment.mediaType,
      byteLength: attachment.byteLength,
      status: "READY",
      loadedBytes: attachment.byteLength,
      totalBytes: attachment.byteLength,
      artifactId: attachment.artifactId,
      visualRequirement: attachment.visualRequirement,
    }));
    const unavailableItems: AttachmentQueueItem[] = unavailableIds.map((artifactId) => ({
      id: `restored:${artifactId}`,
      owner: parsedOwner,
      name: "附件信息暂不可用",
      mediaType: "application/octet-stream",
      byteLength: 0,
      status: "FAILED" as const,
      loadedBytes: 0,
      totalBytes: 0,
      artifactId,
      error: "无法读取该附件，请移除后重新添加。",
    }));
    queue.items = [...restoredItems, ...unavailableItems];
    queue.snapshot = queueSnapshot(queue.items);
    this.queues.set(key, queue);
    this.publish();
  }

  async addFiles(files: readonly File[], owner: AttachmentOwner): Promise<void> {
    if (this.disposed || files.length === 0) return;
    const parsedOwner = AttachmentOwnerSchema.parse(owner);
    const queue = this.getOrCreateQueue(parsedOwner);
    let retainedBytes = queue.items.reduce(
      (sum, item) =>
        sum + (item.file !== undefined || item.artifactId !== undefined ? item.byteLength : 0),
      0,
    );
    let retainedCount = queue.items.filter(
      (item) => item.file !== undefined || item.artifactId !== undefined,
    ).length;

    for (const file of files) {
      const id = this.createLocalId();
      const name = file.name;
      const mediaType = file.type || "application/octet-stream";
      let error: string | undefined;
      if (!AttachmentNameSchema.safeParse(name).success) {
        error = "文件名无效，无法上传。";
      } else if (file.size > MAX_ATTACHMENT_BYTES) {
        error = "单个文件不能超过 25 MiB。";
      } else if (retainedBytes + file.size > MAX_MESSAGE_ATTACHMENT_BYTES) {
        error = "附件总大小不能超过 100 MiB。";
      } else if (retainedCount >= MAX_ATTACHMENT_COUNT) {
        error = `每条消息最多添加 ${MAX_ATTACHMENT_COUNT} 个附件。`;
      }

      const item: AttachmentQueueItem = {
        id,
        owner: parsedOwner,
        name,
        mediaType,
        byteLength: file.size,
        status: error === undefined ? "VALIDATING" : "FAILED",
        loadedBytes: 0,
        totalBytes: file.size,
        ...(error === undefined ? { file } : { error }),
      };
      queue.items = [...queue.items, item];
      if (error === undefined) {
        retainedBytes += file.size;
        retainedCount += 1;
      }
    }
    this.queues.set(ownerKey(parsedOwner), queue);
    queue.snapshot = queueSnapshot(queue.items);
    this.publish();
    const tasks = queue.items
      .filter((item) => item.status === "VALIDATING")
      .map((item) => this.upload(item));
    await Promise.all(tasks);
  }

  async retry(id: string): Promise<void> {
    const item = this.findItem(id);
    if (
      item === undefined ||
      item.status !== "FAILED" ||
      item.file === undefined ||
      this.disposed
    ) {
      return;
    }
    await this.upload(item);
  }

  remove(id: string): void {
    const controller = this.uploads.get(id);
    if (controller !== undefined) controller.abort();
    this.uploads.delete(id);
    for (const [key, queue] of this.queues) {
      if (!queue.items.some((item) => item.id === id)) continue;
      queue.items = queue.items.filter((item) => item.id !== id);
      queue.snapshot = queueSnapshot(queue.items);
      this.queues.set(key, queue);
      this.publish();
      return;
    }
  }

  activate(): void {
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.uploads.values()) controller.abort();
    this.uploads.clear();
    this.listeners.clear();
  }

  private async upload(item: AttachmentQueueItem): Promise<void> {
    if (item.file === undefined || this.disposed) return;
    const controller = new AbortController();
    this.uploads.set(item.id, controller);
    this.updateItem(item.id, (current) => {
      const { error, ...withoutError } = current;
      void error;
      return { ...withoutError, status: "UPLOADING", loadedBytes: 0 };
    });
    const input: AttachmentUploadOptions = {
      owner: item.owner,
      name: item.name,
      mediaType: item.mediaType,
      signal: controller.signal,
      onProgress: ({ loadedBytes, totalBytes }) => {
        this.updateItem(item.id, (current) => ({
          ...current,
          loadedBytes: Math.max(0, Math.min(loadedBytes, item.byteLength)),
          status:
            item.byteLength > 0 && loadedBytes >= item.byteLength ? "PREPROCESSING" : "UPLOADING",
          totalBytes: Math.min(totalBytes, item.byteLength),
        }));
      },
    };
    try {
      const descriptor = await this.client.uploadAttachment(item.file, input);
      this.updateItem(item.id, (current) => {
        const { error, ...withoutError } = current;
        void error;
        return {
          ...withoutError,
          name: descriptor.name,
          mediaType: descriptor.mediaType,
          byteLength: descriptor.byteLength,
          loadedBytes: descriptor.byteLength,
          totalBytes: descriptor.byteLength,
          artifactId: descriptor.artifactId,
          visualRequirement: descriptor.visualRequirement,
          status: "READY",
        };
      });
    } catch (error) {
      if (controller.signal.aborted || this.findItem(item.id) === undefined) return;
      this.updateItem(item.id, (current) => ({
        ...current,
        status: "FAILED",
        error: uploadErrorMessage(error),
      }));
    } finally {
      if (this.uploads.get(item.id) === controller) this.uploads.delete(item.id);
    }
  }

  private updateItem(id: string, update: (item: AttachmentQueueItem) => AttachmentQueueItem): void {
    for (const [key, queue] of this.queues) {
      const index = queue.items.findIndex((item) => item.id === id);
      if (index < 0) continue;
      const items = [...queue.items];
      items[index] = update(items[index]!);
      queue.items = items;
      queue.snapshot = queueSnapshot(items);
      this.queues.set(key, queue);
      this.publish();
      return;
    }
  }

  private findItem(id: string): AttachmentQueueItem | undefined {
    for (const queue of this.queues.values()) {
      const item = queue.items.find((candidate) => candidate.id === id);
      if (item !== undefined) return item;
    }
    return undefined;
  }

  private getOrCreateQueue(owner: AttachmentOwner): OwnerQueue {
    const key = ownerKey(owner);
    const current = this.queues.get(key);
    if (current !== undefined) return current;
    const queue = { owner, items: [], snapshot: EMPTY_QUEUE };
    this.queues.set(key, queue);
    return queue;
  }

  private createLocalId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    this.nextLocalId += 1;
    return `attachment-${this.nextLocalId}`;
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function ownerKey(owner: AttachmentOwner): string {
  const parsed = AttachmentOwnerSchema.parse(owner);
  return parsed.kind === "SESSION"
    ? `session:${parsed.sessionId}`
    : `workspace:${parsed.workspaceId}`;
}

function queueSnapshot(items: readonly AttachmentQueueItem[]): readonly AttachmentQueueItem[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof CaelushClientHttpError && error.code === "INVALID_REQUEST") {
    return "文件格式不受支持，或文件内容无法读取。";
  }
  if (error instanceof CaelushClientHttpError && error.code === "CONFLICT") {
    return "附件状态已变化，请移除后重新添加。";
  }
  return "上传失败，请重试或移除文件。";
}
