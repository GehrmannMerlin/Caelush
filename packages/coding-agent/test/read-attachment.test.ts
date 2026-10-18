import { createReadAttachmentTool, readAttachmentInputSchema } from "@caelush/coding-agent";
import { AttachmentIdSchema, type AttachmentReadResult } from "@caelush/protocol";
import { describe, expect, it, vi } from "vitest";
import { executionInput, testSignal } from "./support/operations-fixtures.js";

const result: AttachmentReadResult = {
  artifactId: AttachmentIdSchema.parse("att_1234567890ab"),
  sha256: "a".repeat(64),
  processorVersion: "attachments-v1",
  range: { kind: "PDF_PAGE", pageNumber: 4 },
  items: [
    {
      type: "TEXT",
      location: { kind: "PDF_PAGE", pageNumber: 4 },
      text: "Quarterly results",
    },
    {
      type: "IMAGE",
      location: { kind: "PDF_PAGE", pageNumber: 4 },
      mediaType: "image/png",
      data: "sensitive-image-bytes",
      width: 800,
      height: 600,
    },
  ],
  truncated: false,
  outputBytes: 100,
};

describe("read_attachment Coding Tool", () => {
  it("reads by opaque attachment id and bounded range under the executing session", async () => {
    const read = vi.fn(async () => result);
    const definition = createReadAttachmentTool({ read });
    const signal = testSignal();

    const input = executionInput(
      { artifactId: result.artifactId, range: result.range },
      { signal },
    );
    const output = await definition.tool.execute(input);

    expect(read).toHaveBeenCalledWith({
      sessionId: input.identity.sessionId,
      artifactId: result.artifactId,
      range: result.range,
      signal,
    });
    expect(output).toMatchObject({
      isError: false,
      content: expect.stringContaining("Quarterly results"),
      details: {
        ok: true,
        truncated: false,
        imageReferences: [
          {
            artifactId: result.artifactId,
            sha256: result.sha256,
            range: result.range,
            location: { kind: "PDF_PAGE", pageNumber: 4 },
            mediaType: "image/png",
          },
        ],
      },
    });
    expect(JSON.stringify(output)).not.toContain("sensitive-image-bytes");
  });

  it("rejects arbitrary host paths and maps only bounded read failures to safe feedback", async () => {
    const read = vi.fn(async () => result);
    const definition = createReadAttachmentTool({ read });

    const invalid = await definition.tool.execute(
      executionInput({
        artifactId: result.artifactId,
        range: { kind: "FILE", path: "../../secrets" },
      }),
    );
    expect(invalid).toMatchObject({ isError: true, details: { error: "INVALID_RANGE" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns image ranges as durable model references without persisting image payloads", async () => {
    const definition = createReadAttachmentTool({ read: async () => result });
    const output = await definition.tool.execute(
      executionInput({ artifactId: result.artifactId, range: result.range }),
    );

    expect(output.details).toHaveProperty("imageReferences");
    expect(output.details).not.toHaveProperty("items");
    expect(output.content).not.toContain("data:image");
  });

  it("advertises a format-neutral first read and every explicit range kind", () => {
    const range = readAttachmentInputSchema.properties.range as unknown as {
      readonly oneOf: readonly { readonly properties: Record<string, unknown> }[];
    };

    expect(range.oneOf).toHaveLength(9);
    expect(range.oneOf[0]?.properties).toEqual({ kind: { type: "string", enum: ["AUTO"] } });
    expect(range.oneOf[1]?.properties).toHaveProperty("cursor");
    for (const branch of range.oneOf) {
      expect(branch).toMatchObject({ additionalProperties: false, type: "object" });
    }
  });

  it("passes a format-neutral range through to the read operation", async () => {
    const read = vi.fn(async () => result);
    const definition = createReadAttachmentTool({ read });

    const output = await definition.tool.execute(
      executionInput({ artifactId: result.artifactId, range: { kind: "AUTO" } }),
    );

    expect(read).toHaveBeenCalledWith(expect.objectContaining({ range: { kind: "AUTO" } }));
    expect(output).toMatchObject({ isError: false, details: { ok: true } });
  });

  it("names the accepted fields when a range uses the wrong keys", async () => {
    const read = vi.fn(async () => result);
    const definition = createReadAttachmentTool({ read });

    const output = await definition.tool.execute(
      executionInput({
        artifactId: result.artifactId,
        range: { kind: "DOCX_BLOCKS", start: 0, count: 10 },
      }),
    );

    expect(output).toMatchObject({ isError: true, details: { error: "INVALID_RANGE" } });
    expect(output.content).toContain("startIndex");
    expect(output.content).toContain("blockCount");
    expect(read).not.toHaveBeenCalled();
  });

  it("distinguishes an invalid attachment id from an invalid range", async () => {
    const definition = createReadAttachmentTool({ read: async () => result });

    const output = await definition.tool.execute(
      executionInput({ artifactId: "简历.pdf", range: { kind: "AUTO" } }),
    );

    expect(output).toMatchObject({ isError: true, details: { error: "INVALID_ARTIFACT" } });
    expect(output.content).toContain("never a file name");
  });
});
