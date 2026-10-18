import { createReadAttachmentTool } from "@caelush/coding-agent";
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
});
