import type { JsonObject } from "@caelush/ai";
import {
  AttachmentIdSchema,
  AttachmentModelContentReferenceSchema,
  AttachmentReadRangeSchema,
  AttachmentReadResultSchema,
} from "@caelush/protocol";
import type {
  AttachmentModelContentReference,
  AttachmentReadRange,
  AttachmentReadResult,
} from "@caelush/protocol";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type {
  AttachmentReadOperationErrorCode,
  AttachmentReadOperations,
} from "../operations/attachment-read-operations.js";
import { AttachmentReadOperationError } from "../operations/attachment-read-operations.js";
import { canonicalJsonString } from "@caelush/agent";
import { defineCodingTool } from "./define-coding-tool.js";
import { errorResult, successResult, asOverlaySecurityFactsProjector } from "./result.js";
import { projectReadAttachmentSecurityFacts } from "../security/security-facts.js";
import { READ_ATTACHMENT_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";

const MAX_MODEL_IMAGE_REFERENCES = 8;
const MAX_TOOL_TEXT_BYTES = 48 * 1024;

const inputSchema = {
  type: "object",
  properties: {
    artifactId: {
      type: "string",
      minLength: 14,
      maxLength: 80,
      description: "Opaque attachment ID from the current conversation; never a host path.",
    },
    range: {
      type: "object",
      minProperties: 1,
      maxProperties: 8,
      properties: {
        kind: {
          type: "string",
          enum: [
            "MANIFEST",
            "TEXT_LINES",
            "SEARCH",
            "PDF_PAGE",
            "DOCX_BLOCKS",
            "XLSX_RANGE",
            "IMAGE",
          ],
        },
      },
      required: ["kind"],
      additionalProperties: true,
      description: "One bounded manifest, line, page, block, sheet, search, or image range.",
    },
  },
  required: ["artifactId", "range"],
  additionalProperties: false,
} as const;

const resultDetailsSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    artifactId: { type: "string" },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    processorVersion: { type: "string", maxLength: 128 },
    range: { type: "object", maxProperties: 8 },
    truncated: { type: "boolean" },
    nextRange: { type: "object", maxProperties: 8 },
    locations: { type: "array", maxItems: 256, items: { type: "object", maxProperties: 5 } },
    imageReferences: {
      type: "array",
      maxItems: MAX_MODEL_IMAGE_REFERENCES,
      items: {
        type: "object",
        properties: {
          artifactId: { type: "string" },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          range: { type: "object", maxProperties: 8 },
          location: { type: "object", maxProperties: 4 },
          mediaType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
        },
        required: ["artifactId", "sha256", "range", "location", "mediaType"],
        additionalProperties: false,
      },
    },
    omittedImageReferences: { type: "integer", minimum: 0, maximum: 256 },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

/** A dispatcher-backed read-only Tool for one bounded conversation attachment range. */
export function createReadAttachmentTool(
  operations: AttachmentReadOperations,
): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "read_attachment",
    description: "Read a bounded range from an attached file.",
    inputSchema,
    resultDetailsSchema,
    execute: async (input) => {
      let artifactId: string;
      let range: AttachmentReadRange;
      try {
        artifactId = AttachmentIdSchema.parse(input.args["artifactId"]);
        range = AttachmentReadRangeSchema.parse(input.args["range"]);
      } catch {
        return errorResult("INVALID_RANGE", "Attachment read failed: INVALID_RANGE.");
      }

      let result: AttachmentReadResult;
      try {
        result = AttachmentReadResultSchema.parse(
          await operations.read({
            sessionId: input.identity.sessionId,
            artifactId: AttachmentIdSchema.parse(artifactId),
            range,
            signal: input.signal,
          }),
        );
      } catch (error) {
        if (!(error instanceof AttachmentReadOperationError)) throw error;
        return safeOperationError(error.code);
      }
      if (result.artifactId !== artifactId) {
        throw new AttachmentReadOperationError("PROCESSOR_FAILED");
      }

      const references = result.items
        .filter(
          (item): item is Extract<AttachmentReadResult["items"][number], { type: "IMAGE" }> =>
            item.type === "IMAGE",
        )
        .map((item) =>
          AttachmentModelContentReferenceSchema.parse({
            artifactId: result.artifactId,
            sha256: result.sha256,
            range: result.range,
            location: item.location,
            mediaType: item.mediaType,
          }),
        );
      const modelReferences = references.slice(0, MAX_MODEL_IMAGE_REFERENCES);
      const omittedImageReferences = Math.max(0, references.length - modelReferences.length);
      const content = boundOutputText(
        renderResult(result, modelReferences, omittedImageReferences),
      );
      const details = {
        ok: true,
        artifactId: result.artifactId,
        sha256: result.sha256,
        processorVersion: result.processorVersion,
        range: result.range,
        truncated: result.truncated,
        ...(result.nextRange === undefined ? {} : { nextRange: result.nextRange }),
        locations: result.items.map((item) => item.location),
        imageReferences: modelReferences,
        omittedImageReferences,
      };
      return successResult(content, details as unknown as JsonObject);
    },
  });

  return {
    tool,
    security: {
      riskLevel: "LOW",
      requiredCapabilities: ["FS_READ"],
      runtimeRequirements: { runtimeKinds: ["local"] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectReadAttachmentSecurityFacts),
    promptSnippet: READ_ATTACHMENT_PROMPT_SNIPPET,
  };
}

export { inputSchema as readAttachmentInputSchema };

function renderResult(
  result: AttachmentReadResult,
  imageReferences: readonly AttachmentModelContentReference[],
  omittedImageReferences: number,
): string {
  const lines = result.items.map((item) => {
    if (item.type === "TEXT") return `[${formatLocation(item.location)}]\n${item.text}`;
    if (item.type === "CELL") {
      const formula = item.formula === undefined ? "" : ` formula=${item.formula}`;
      const value = item.value === undefined ? "" : ` value=${String(item.value)}`;
      return `[${formatLocation(item.location)}]${formula}${value}`;
    }
    return `[${formatLocation(item.location)}] image ${item.mediaType} (${String(item.width)}×${String(item.height)}).`;
  });
  if (lines.length === 0) lines.push("No content was found in this range.");
  if (imageReferences.length > 0) {
    lines.push(
      `${String(imageReferences.length)} image reference(s) will be available in the next model turn.`,
    );
  }
  if (omittedImageReferences > 0) {
    lines.push(
      `${String(omittedImageReferences)} additional image reference(s) were omitted by the per-result limit.`,
    );
  }
  if (result.truncated && result.nextRange !== undefined) {
    lines.push(
      `Read is incomplete. Continue with range ${canonicalJsonString(JSON.parse(JSON.stringify(result.nextRange)) as JsonObject)}.`,
    );
  } else if (result.truncated) {
    lines.push("Read is incomplete; request a narrower range to continue.");
  } else {
    lines.push("Coverage: complete for the requested range.");
  }
  return lines.join("\n\n");
}

function formatLocation(location: AttachmentReadResult["items"][number]["location"]): string {
  switch (location.kind) {
    case "MANIFEST":
      return "manifest";
    case "TEXT_LINES":
      return `lines ${String(location.startLine)}-${String(location.endLine)}`;
    case "PDF_PAGE":
      return `page ${String(location.pageNumber)}`;
    case "DOCX_BLOCK":
      return `block ${String(location.blockIndex)}`;
    case "DOCX_TABLE_CELL":
      return `table block ${String(location.blockIndex)}, row ${String(location.rowIndex + 1)}, column ${String(location.columnIndex + 1)}`;
    case "DOCX_IMAGE":
      return `document image ${String(location.imageIndex + 1)}`;
    case "XLSX_CELL":
      return `${location.sheetName}!${location.address}`;
    case "XLSX_IMAGE":
      return `${location.sheetName}!${location.cellAddress}`;
    case "IMAGE":
      return "image";
  }
}

function boundOutputText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_TOOL_TEXT_BYTES) return text;
  const prefix = new TextDecoder().decode(bytes.subarray(0, MAX_TOOL_TEXT_BYTES - 64));
  return `${prefix}\n\n[Tool output was shortened; use a narrower range to continue.]`;
}

function safeOperationError(code: AttachmentReadOperationErrorCode) {
  return errorResult(code, `Attachment read failed: ${code}.`);
}
