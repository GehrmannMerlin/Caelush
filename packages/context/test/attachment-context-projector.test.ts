import { describe, expect, it } from "vitest";
import { AttachmentIdSchema, type AttachmentId } from "@caelush/protocol";

import { projectAttachmentContext } from "../src/attachments/attachment-context-projector.js";
import type {
  AttachmentContextDocument,
  AttachmentContextProjectionInput,
} from "../src/attachments/attachment-context-projector.js";

const ARTIFACT_ID = AttachmentIdSchema.parse("att_0123456789ab");
const OTHER_ARTIFACT_ID = AttachmentIdSchema.parse("att_1123456789ab");
const SHA256 = "a".repeat(64);
const OTHER_SHA256 = "b".repeat(64);

function textDocument(input: {
  artifactId?: AttachmentId;
  sha256?: string;
  text: string;
  truncated?: boolean;
}): AttachmentContextDocument {
  const artifactId = input.artifactId ?? ARTIFACT_ID;
  const sha256 = input.sha256 ?? SHA256;
  return {
    descriptor: {
      artifactId,
      name: "notes.txt",
      mediaType: "text/plain",
      byteLength: input.text.length,
      sha256,
    },
    manifest: {
      artifactId,
      sha256,
      mediaType: "text/plain",
      processorVersion: "attachments-v1",
      visualRequirement: "NOT_REQUIRED",
      kind: "TEXT",
      encoding: "UTF-8",
      lineCount: 1,
      characterCount: input.text.length,
    },
    readResults: [
      {
        artifactId,
        sha256: input.sha256 === undefined ? SHA256 : input.sha256,
        processorVersion: "attachments-v1",
        range: { kind: "TEXT_LINES", startLine: 1, lineCount: 1 },
        items: [
          {
            type: "TEXT",
            location: { kind: "TEXT_LINES", startLine: 1, endLine: 1 },
            text: input.text,
          },
        ],
        truncated: input.truncated ?? false,
        ...(input.truncated === true
          ? { nextRange: { kind: "TEXT_LINES" as const, startLine: 1, lineCount: 1 } }
          : {}),
        outputBytes: 1,
      },
    ],
  };
}

function project(
  documents: readonly AttachmentContextDocument[],
  remainingTokenBudget: number,
): ReturnType<typeof projectAttachmentContext> {
  return projectAttachmentContext({
    attachments: documents,
    remainingTokenBudget,
    estimateTokens: (text) => Math.ceil(new TextEncoder().encode(text).byteLength / 3),
  } satisfies AttachmentContextProjectionInput);
}

describe("attachment Context projection", () => {
  it("includes a complete small text attachment and reports its exact range", () => {
    const projection = project([textDocument({ text: "hello file" })], 200);

    expect(projection.omittedIds).toEqual([]);
    expect(projection.attachments).toEqual([
      expect.objectContaining({
        artifactId: ARTIFACT_ID,
        omitted: false,
        content: [
          expect.objectContaining({ type: "text", text: expect.stringContaining("hello file") }),
        ],
        includedRanges: [
          expect.objectContaining({
            range: { kind: "TEXT_LINES", startLine: 1, lineCount: 1 },
            locations: [{ kind: "TEXT_LINES", startLine: 1, endLine: 1 }],
          }),
        ],
      }),
    ]);
    expect(projection.tokenEstimate).toBeGreaterThan(0);
  });

  it("does not silently include a truncated read", () => {
    const projection = project([textDocument({ text: "partial data", truncated: true })], 200);

    expect(projection.omittedIds).toEqual([ARTIFACT_ID]);
    expect(projection.attachments[0]).toMatchObject({
      omitted: true,
      content: [],
      includedRanges: [],
    });
  });

  it("omits a complete attachment that does not fit without truncating it", () => {
    const projection = project([textDocument({ text: "too much" })], 1);

    expect(projection.omittedIds).toEqual([ARTIFACT_ID]);
    expect(projection.attachments[0]).toMatchObject({
      omitted: true,
      content: [],
      includedRanges: [],
    });
    expect(projection.tokenEstimate).toBe(0);
  });

  it("allocates the remaining budget across attachments and continues after an omission", () => {
    const projection = project(
      [
        textDocument({ text: "this first document will not fit" }),
        textDocument({ artifactId: OTHER_ARTIFACT_ID, text: "ok" }),
      ],
      15,
    );

    expect(projection.omittedIds).toEqual([ARTIFACT_ID]);
    expect(projection.attachments.map((attachment) => attachment.omitted)).toEqual([true, false]);
    expect(projection.tokenEstimate).toBeLessThanOrEqual(80);
  });

  it("fails closed when a read result hash differs from its durable manifest", () => {
    const base = textDocument({ text: "hello", sha256: OTHER_SHA256 });
    const invalid: AttachmentContextDocument = {
      ...base,
      readResults: [
        {
          ...base.readResults[0]!,
          sha256: SHA256,
        },
      ],
    };

    expect(() => project([invalid], 200)).toThrowError(
      expect.objectContaining({ code: "INVALID_SNAPSHOT" }),
    );
  });

  it("charges a non-zero image estimate and preserves the returned image bytes", () => {
    const image: AttachmentContextDocument = {
      descriptor: {
        artifactId: ARTIFACT_ID,
        name: "screen.png",
        mediaType: "image/png",
        byteLength: 12,
        sha256: SHA256,
      },
      manifest: {
        artifactId: ARTIFACT_ID,
        sha256: SHA256,
        mediaType: "image/png",
        processorVersion: "attachments-v1",
        visualRequirement: "REQUIRED",
        kind: "IMAGE",
        width: 800,
        height: 600,
        frameCount: 1,
        animated: false,
      },
      readResults: [
        {
          artifactId: ARTIFACT_ID,
          sha256: SHA256,
          processorVersion: "attachments-v1",
          range: { kind: "IMAGE" },
          items: [
            {
              type: "IMAGE",
              location: { kind: "IMAGE" },
              mediaType: "image/png",
              data: "iVBORw0KGgo=",
              width: 800,
              height: 600,
            },
          ],
          truncated: false,
          outputBytes: 12,
        },
      ],
    };
    const projection = projectAttachmentContext({
      attachments: [image],
      remainingTokenBudget: 2_000,
      estimateTokens: (text) => Math.ceil(new TextEncoder().encode(text).byteLength / 3),
    });

    expect(projection.attachments[0]?.content).toContainEqual({
      type: "image",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(projection.tokenEstimate).toBeGreaterThan(0);
  });
});
