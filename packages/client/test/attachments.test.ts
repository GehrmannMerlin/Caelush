import { createWorkspaceId, type AttachmentOwner } from "@caelush/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaelushClient, CaelushClientHttpError } from "../src/client.js";

const owner: AttachmentOwner = { kind: "WORKSPACE", workspaceId: createWorkspaceId() };
const descriptor = {
  artifactId: "att_abcdefghijklmnop",
  workspaceId: owner.workspaceId,
  name: "notes.txt",
  mediaType: "text/plain",
  byteLength: 5,
  sha256: "a".repeat(64),
  status: "READY",
  visualRequirement: "NOT_REQUIRED",
  processorVersion: "documents-v1",
};

class FakeXhr {
  static instances: FakeXhr[] = [];
  readonly upload: { onprogress: ((event: { readonly loaded: number }) => void) | null } = {
    onprogress: null,
  };
  status = 0;
  responseText = "";
  url = "";
  headers = new Map<string, string>();
  sent: Blob | undefined;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  send(body: Blob) {
    this.sent = body;
  }
  abort() {
    this.onabort?.();
  }
  finish(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
});

describe("CaelushClient attachments", () => {
  it("streams attachment bytes, reports actual progress, and validates the descriptor", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const client = new CaelushClient({ baseUrl: "http://daemon.test" });
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];
    const promise = client.uploadAttachment(new Blob(["hello"]), {
      owner,
      name: "notes.txt",
      mediaType: "text/plain",
      onProgress: (item) => progress.push(item),
    });
    const request = FakeXhr.instances[0]!;
    request.upload.onprogress?.({ loaded: 3 });
    request.finish(201, descriptor);

    await expect(promise).resolves.toMatchObject({ artifactId: descriptor.artifactId });
    expect(request.url).toBe("http://daemon.test/api/v1/attachments");
    expect(request.sent?.size).toBe(5);
    expect(request.headers.get("x-caelush-owner-kind")).toBe("WORKSPACE");
    expect(request.headers.get("x-caelush-owner-id")).toBe(owner.workspaceId);
    expect(progress).toEqual([{ loadedBytes: 3, totalBytes: 5 }]);
  });

  it("loads and saves an owner-scoped draft using revisioned JSON contracts", async () => {
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") return Response.json({ draft: null });
        return Response.json({
          draft: {
            owner,
            revision: 2,
            text: "hello",
            artifactIds: [descriptor.artifactId],
          },
        });
      },
    });

    await expect(client.getAttachmentDraft(owner)).resolves.toBeNull();
    await expect(
      client.saveAttachmentDraft(owner, {
        expectedRevision: 1,
        text: "hello",
        artifactIds: [descriptor.artifactId as never],
      }),
    ).resolves.toMatchObject({ revision: 2, text: "hello" });
    expect(requests[0]?.url).toContain(`ownerKind=WORKSPACE&ownerId=${owner.workspaceId}`);
    expect(await requests[1]?.json()).toMatchObject({ expectedRevision: 1, text: "hello" });
  });

  it("downloads a private attachment with the requested safe disposition", async () => {
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response("image", { status: 200, headers: { "content-type": "image/png" } });
      },
    });

    await expect(
      client.downloadAttachment(descriptor.artifactId as never, owner, { inlinePreview: true }),
    ).resolves.toBeInstanceOf(Blob);
    expect(requests[0]?.url).toContain("disposition=inline");
    expect(requests[0]?.url).toContain(`ownerKind=WORKSPACE&ownerId=${owner.workspaceId}`);
  });

  it("loads only the safe attachment metadata needed to restore a draft card", async () => {
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          attachment: {
            artifactId: descriptor.artifactId,
            name: descriptor.name,
            mediaType: descriptor.mediaType,
            byteLength: descriptor.byteLength,
            visualRequirement: descriptor.visualRequirement,
          },
        });
      },
    });

    await expect(
      client.getAttachmentMetadata(descriptor.artifactId as never, owner),
    ).resolves.toMatchObject({ name: "notes.txt", mediaType: "text/plain" });
    expect(requests[0]?.url).toContain("/metadata?ownerKind=WORKSPACE");
  });

  it("preserves stable daemon errors for upload failures", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const client = new CaelushClient({ baseUrl: "http://daemon.test" });
    const promise = client.uploadAttachment(new Blob(["hello"]), {
      owner,
      name: "notes.txt",
      mediaType: "text/plain",
    });
    FakeXhr.instances[0]!.finish(413, {
      error: {
        code: "INVALID_REQUEST",
        message: "Attachment exceeds a supported limit.",
        requestId: "request-1",
      },
    });
    await expect(promise).rejects.toBeInstanceOf(CaelushClientHttpError);
    await expect(promise).rejects.toMatchObject({
      status: 413,
      code: "INVALID_REQUEST",
      requestId: "request-1",
    });
  });
});
