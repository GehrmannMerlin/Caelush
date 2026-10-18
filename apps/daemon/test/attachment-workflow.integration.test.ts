import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput } from "@caelush/ai";
import { CaelushClient } from "@caelush/client";
import { ATTACHMENT_ONLY_RUN_GOAL, SubmissionIdSchema, createWorkspaceId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/index.js";
import { FIXTURE_API, fixtureBinding, fixtureModelSource } from "./support/ai-fixture.js";

let directory: string | undefined;
let daemon: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await daemon?.close().catch(() => undefined);
  daemon = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

class AttachmentProvider implements ApiAdapter {
  readonly id = FIXTURE_API;
  readonly requests: ApiAdapterStreamInput["request"]["messages"][] = [];
  readArtifactId: string | undefined;

  async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    this.requests.push(input.request.messages);
    if (this.readArtifactId !== undefined && this.requests.length === 1) {
      yield {
        type: "tool_call.start",
        payload: { toolCallId: "read_attachment_call", toolName: "read_attachment" },
      };
      yield {
        type: "tool_call.completed",
        payload: {
          id: "read_attachment_call",
          name: "read_attachment",
          input: { artifactId: this.readArtifactId, range: { kind: "MANIFEST" } },
        },
      };
      yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
      return;
    }
    yield { type: "text.delta", payload: { text: "已读取附件内容。" } };
    yield { type: "adapter.finish", payload: { finishReason: "STOP" } };
  }
}

function visionModelSource() {
  const source = fixtureModelSource();
  return {
    ...source,
    resolve: (ref: Parameters<typeof source.resolve>[0]) => {
      const descriptor = source.resolve(ref);
      return descriptor === undefined
        ? undefined
        : {
            ...descriptor,
            capabilities: { ...descriptor.capabilities, vision: "SUPPORTED" as const },
          };
    },
    list: () =>
      source.list().map((descriptor) => ({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, vision: "SUPPORTED" as const },
      })),
  };
}

async function startFixtureDaemon(databasePath: string, provider: AttachmentProvider) {
  return startDaemon({
    databasePath,
    port: 0,
    sseHeartbeatIntervalMs: 0,
    providerBindings: [fixtureBinding()],
    modelSources: [visionModelSource()],
    adapterOverrides: [provider],
    defaultModel: { provider: "fixture", model: "fixture-model" },
  });
}

describe("attachment workflow integration", () => {
  it("uploads, restores, submits, replays and authorizes a multimodal attachment-only turn", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-attachment-workflow-e2e-"));
    const databasePath = join(directory, "caelush.db");
    const provider = new AttachmentProvider();
    daemon = await startFixtureDaemon(databasePath, provider);
    let client = new CaelushClient({ baseUrl: daemon.url });
    const session = await client.createSession({
      defaultWorkspace: { id: createWorkspaceId(), path: directory },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const workspace = session.defaultWorkspace;
    if (workspace === undefined) throw new Error("test Workspace was not registered");
    const owner = { kind: "WORKSPACE", workspaceId: workspace.id } as const;
    const textName = "项目说明.txt";
    const textBytes = Buffer.from("ATTACHMENT_CONTEXT_MARKER: review the parser boundary.", "utf8");
    const imageBytes = await readFile(new URL("./attachments/fixtures/pixel.png", import.meta.url));
    const textUpload = await upload(daemon.url, owner, textName, "text/plain", textBytes);
    const imageUpload = await upload(daemon.url, owner, "屏幕截图.png", "image/png", imageBytes);
    provider.readArtifactId = textUpload.artifactId;
    const attachmentIds = [textUpload.artifactId, imageUpload.artifactId] as const;
    await client.saveAttachmentDraft(owner, {
      expectedRevision: 0,
      text: "",
      artifactIds: attachmentIds,
      submissionId: SubmissionIdSchema.parse(randomUUID()),
    });

    await expect(client.getAttachmentDraft(owner)).resolves.toMatchObject({
      text: "",
      artifactIds: attachmentIds,
      revision: 1,
    });

    const otherSession = await client.createSession({
      defaultWorkspace: workspace,
      defaultModel: { provider: "fixture", model: "fixture-model" },
    });
    const submissionId = SubmissionIdSchema.parse(randomUUID());
    const runRequest = {
      goal: ATTACHMENT_ONLY_RUN_GOAL,
      userText: "",
      attachmentIds,
      submissionId,
      workspace,
      model: { provider: "fixture", model: "fixture-model" },
      runtime: { id: "local", kind: "local" },
      preset: { id: "FULL_ACCESS", expectedVersion: 1 },
      limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 60_000 },
    } as const;
    const run = await client.createRun(session.id, runRequest);
    await expect(client.createRun(session.id, runRequest)).resolves.toMatchObject({ id: run.id });
    const started = await client.startRun(run.id);
    expect(started.disposition).toBe("SCHEDULED");

    let settled = await client.getRun(run.id);
    for (let attempt = 0; attempt < 2_400 && !isTerminal(settled.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await client.getRun(run.id);
    }
    const historyAfterRun = await client.getSessionTranscript(session.id);
    expect(
      settled.status,
      JSON.stringify({
        providerRequests: provider.requests.length,
        transcript: historyAfterRun.items.map((item) => ({
          kind: item.kind,
          text: "text" in item ? item.text.slice(0, 100) : "",
        })),
      }),
    ).toBe("COMPLETED");
    expect(settled.userText).toBe("");
    expect(provider.requests).toHaveLength(2);
    const serializedRequest = JSON.stringify(provider.requests[0]);
    expect(serializedRequest).toContain("ATTACHMENT_CONTEXT_MARKER");
    const imagePart = provider.requests[0]
      ?.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
      .find((part) => part.type === "image");
    expect(imagePart).toMatchObject({ type: "image", mediaType: "image/png" });
    if (imagePart?.type !== "image") throw new Error("processed image input is missing");
    expect(Buffer.from(imagePart.data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(provider.requests[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", toolName: "read_attachment" }),
      ]),
    );

    const transcript = await client.getSessionTranscript(session.id);
    const userEntry = transcript.items.find(
      (item) => item.runId === run.id && item.kind === "USER",
    );
    expect(userEntry).toMatchObject({
      text: "",
      attachments: [
        {
          name: textName,
          mediaType: "text/plain",
          byteLength: textBytes.byteLength,
          downloadAvailable: true,
        },
        { name: "屏幕截图.png", mediaType: "image/png", previewAvailable: true },
      ],
    });
    expect(JSON.stringify(userEntry)).not.toContain(textUpload.sha256);
    expect(JSON.stringify(userEntry)).not.toContain(directory);

    const downloaded = await client.downloadAttachment(textUpload.artifactId, {
      kind: "SESSION",
      sessionId: session.id,
    });
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(textBytes);
    await expect(
      client.downloadAttachment(textUpload.artifactId, {
        kind: "SESSION",
        sessionId: otherSession.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await daemon.close();
    daemon = await startFixtureDaemon(databasePath, provider);
    client = new CaelushClient({ baseUrl: daemon.url });
    await expect(client.getRun(run.id)).resolves.toMatchObject({
      status: "COMPLETED",
      userText: "",
    });
    const reopenedTranscript = await client.getSessionTranscript(session.id);
    expect(reopenedTranscript.items.filter((item) => item.runId === run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "USER", text: "", attachments: expect.any(Array) }),
        expect.objectContaining({ kind: "ASSISTANT", text: "已读取附件内容。" }),
      ]),
    );
  }, 90_000);
});

async function upload(
  baseUrl: string,
  owner: { readonly kind: "WORKSPACE"; readonly workspaceId: string },
  name: string,
  mediaType: string,
  bytes: Buffer,
) {
  const response = await fetch(`${baseUrl}/api/v1/attachments`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-caelush-owner-kind": owner.kind,
      "x-caelush-owner-id": owner.workspaceId,
      "x-caelush-filename": encodeURIComponent(name),
      "x-caelush-filename-encoding": "uri-component-v1",
      "x-caelush-media-type": mediaType,
      "x-caelush-byte-length": String(bytes.byteLength),
    },
    body: new Uint8Array(bytes),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    readonly artifactId: `att_${string}`;
    readonly sha256: string;
  };
}

function isTerminal(status: string): boolean {
  return ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(status);
}
