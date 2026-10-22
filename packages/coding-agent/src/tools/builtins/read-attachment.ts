import type { JsonObject } from "@caelush/ai";
import {
  AttachmentIdSchema,
  AttachmentModelContentReferenceSchema,
  AttachmentReadRangeSchema,
  AttachmentReadResultSchema,
  MAX_ATTACHMENT_READ_CURSOR_CHARS,
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
/** One tool result may carry a full document page and still keep its continuation line. */
const MAX_TOOL_TEXT_BYTES = 180 * 1024;

interface RangeBranch {
  readonly kind: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  /** The fields this kind accepts, rendered into a recoverable error message. */
  readonly expects: string;
}

const RANGE_BRANCHES: readonly RangeBranch[] = [
  {
    kind: "AUTO",
    description:
      "Recommended first read. Returns a bounded beginning of the file plus an explicit continuation, without requiring any format-specific field.",
    properties: {},
    required: [],
    expects: '"kind"',
  },
  {
    kind: "CONTINUE",
    description:
      "Replay the exact next range a previous result returned, copied verbatim. Prefer this over reconstructing a range by hand.",
    properties: {
      cursor: {
        type: "string",
        minLength: 2,
        maxLength: MAX_ATTACHMENT_READ_CURSOR_CHARS,
        description:
          "The JSON text of the range to replay, exactly as a previous result returned it.",
      },
    },
    required: ["cursor"],
    expects: '"kind", "cursor"',
  },
  {
    kind: "MANIFEST",
    description:
      "File metadata only: page, block or sheet counts and which ranges can be read. Use it before a targeted read.",
    properties: {},
    required: [],
    expects: '"kind"',
  },
  {
    kind: "TEXT_LINES",
    description: "Read a line range from a text file. Line numbers are 1-indexed.",
    properties: {
      startLine: { type: "integer", minimum: 1, maximum: 1_000_000 },
      lineCount: { type: "integer", minimum: 1, maximum: 500 },
      startCharacter: { type: "integer", minimum: 0 },
    },
    required: ["startLine", "lineCount"],
    expects: '"kind", "startLine", "lineCount", optional "startCharacter"',
  },
  {
    kind: "SEARCH",
    description: "Search a text, PDF or DOCX document and return matching locations.",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 512 },
      maxMatches: { type: "integer", minimum: 1, maximum: 100 },
      startMatch: { type: "integer", minimum: 0 },
    },
    required: ["query", "maxMatches"],
    expects: '"kind", "query", "maxMatches", optional "startMatch"',
  },
  {
    kind: "PDF_PAGE",
    description: "Read one PDF page by its 1-indexed page number.",
    properties: {
      pageNumber: { type: "integer", minimum: 1, maximum: 250 },
      textOffset: { type: "integer", minimum: 0 },
    },
    required: ["pageNumber"],
    expects: '"kind", "pageNumber", optional "textOffset"',
  },
  {
    kind: "DOCX_BLOCKS",
    description:
      "Read a block range from a Word document. Blocks are ordered paragraphs, tables and images.",
    properties: {
      startIndex: { type: "integer", minimum: 0, maximum: 4_999 },
      blockCount: { type: "integer", minimum: 1, maximum: 100 },
      tableRow: { type: "integer", minimum: 0 },
      tableColumn: { type: "integer", minimum: 0 },
      textOffset: { type: "integer", minimum: 0 },
      imageIndex: { type: "integer", minimum: 0 },
    },
    required: ["startIndex", "blockCount"],
    expects:
      '"kind", "startIndex", "blockCount", optional "tableRow", "tableColumn", "textOffset", "imageIndex"',
  },
  {
    kind: "XLSX_RANGE",
    description:
      'Read a rectangular spreadsheet range, for example sheetName "Summary" and range "A1:C10".',
    properties: {
      sheetName: { type: "string", minLength: 1, maxLength: 31 },
      range: {
        type: "string",
        minLength: 1,
        maxLength: 32,
        pattern: "^\\$?[A-Z]{1,3}\\$?[1-9][0-9]*(?::\\$?[A-Z]{1,3}\\$?[1-9][0-9]*)?$",
      },
      startCell: { type: "string", pattern: "^[A-Z]{1,3}[1-9][0-9]*$" },
      startImageIndex: { type: "integer", minimum: 0, maximum: 256 },
      skipCell: { type: "boolean" },
      textOffset: { type: "integer", minimum: 0 },
    },
    required: ["sheetName", "range"],
    expects:
      '"kind", "sheetName", "range", optional "startCell", "startImageIndex", "skipCell", "textOffset"',
  },
  {
    kind: "IMAGE",
    description: "Read the attached image itself. Only valid for an image attachment.",
    properties: {},
    required: [],
    expects: '"kind"',
  },
];

const RANGE_EXPECTS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(RANGE_BRANCHES.map((branch) => [branch.kind, branch.expects])),
);

const RANGE_KINDS = RANGE_BRANCHES.map((branch) => branch.kind);

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
      description:
        'One bounded read request. Start with {"kind":"AUTO"}; continue with the exact range a previous result returned.',
      oneOf: RANGE_BRANCHES.map((branch) => ({
        type: "object",
        properties: {
          kind: { type: "string", enum: [branch.kind] },
          ...branch.properties,
        },
        required: ["kind", ...branch.required],
        additionalProperties: false,
        description: branch.description,
      })),
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
    scheduling: { class: "READ_ONLY" },
    description: "Read a bounded range from an attached file.",
    inputSchema,
    resultDetailsSchema,
    execute: async (input) => {
      let artifactId: string;
      try {
        artifactId = AttachmentIdSchema.parse(input.args["artifactId"]);
      } catch {
        return errorResult(
          "INVALID_ARTIFACT",
          "Attachment read failed: INVALID_ARTIFACT. Use the opaque artifactId copied from the conversation, never a file name, label or host path.",
        );
      }

      let range: AttachmentReadRange;
      try {
        range = AttachmentReadRangeSchema.parse(input.args["range"]);
      } catch {
        return invalidRangeResult(input.args["range"]);
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
      const content = renderResult(result, modelReferences, omittedImageReferences);
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

/**
 * A range that failed validation gets a message the model can act on in one turn.
 *
 * The kind is echoed only when it looks like a range kind, so arbitrary model text never reaches the
 * transcript. The accepted field list is static per kind and comes from the same table that builds
 * the schema.
 */
function invalidRangeResult(raw: unknown): ReturnType<typeof errorResult> {
  const kind =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)["kind"]
      : undefined;
  if (typeof kind === "string" && /^[A-Z_]{1,32}$/u.test(kind)) {
    const expected = RANGE_EXPECTS[kind];
    if (expected !== undefined) {
      return errorResult(
        "INVALID_RANGE",
        `Attachment read failed: INVALID_RANGE. Range kind "${kind}" accepts: ${expected}.`,
      );
    }
    return errorResult(
      "INVALID_RANGE",
      `Attachment read failed: INVALID_RANGE. Unknown range kind "${kind}". Use one of: ${RANGE_KINDS.join(", ")}.`,
    );
  }
  return errorResult(
    "INVALID_RANGE",
    `Attachment read failed: INVALID_RANGE. "range" must be an object with "kind" set to one of: ${RANGE_KINDS.join(", ")}.`,
  );
}

function renderResult(
  result: AttachmentReadResult,
  imageReferences: readonly AttachmentModelContentReference[],
  omittedImageReferences: number,
): string {
  const blocks = result.items.map((item) => {
    if (item.type === "TEXT") return `[${formatLocation(item.location)}]\n${item.text}`;
    if (item.type === "CELL") {
      const formula = item.formula === undefined ? "" : ` formula=${item.formula}`;
      const value = item.value === undefined ? "" : ` value=${String(item.value)}`;
      return `[${formatLocation(item.location)}]${formula}${value}`;
    }
    return `[${formatLocation(item.location)}] image ${item.mediaType} (${String(item.width)}×${String(item.height)}).`;
  });
  if (blocks.length === 0) blocks.push("No content was found in this range.");

  // Reserve the longest footer the fit could produce, then state the real one. The footer is the only
  // line a model must never lose, so it is measured against the budget rather than truncated with the
  // content it describes.
  const reservedFooter = resultFooter(
    result,
    imageReferences.length,
    omittedImageReferences,
    blocks.length,
  );
  const budget = MAX_TOOL_TEXT_BYTES - byteLength(reservedFooter) - 8;
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const block of blocks) {
    const size = byteLength(block) + 2;
    if (used + size > budget) {
      dropped = blocks.length - kept.length;
      break;
    }
    kept.push(block);
    used += size;
  }
  kept.push(resultFooter(result, imageReferences.length, omittedImageReferences, dropped));
  return kept.join("\n\n");
}

/**
 * The closing lines are the part a model must never lose: they say whether the read was complete and
 * exactly which range continues it. `dropped` makes a size-truncated result say so instead of
 * claiming complete coverage.
 */
function resultFooter(
  result: AttachmentReadResult,
  imageReferenceCount: number,
  omittedImageReferences: number,
  dropped: number,
): string {
  const lines: string[] = [];
  if (imageReferenceCount > 0) {
    lines.push(
      `${String(imageReferenceCount)} image reference(s) will be available in the next model turn.`,
    );
  }
  if (omittedImageReferences > 0) {
    lines.push(
      `${String(omittedImageReferences)} additional image reference(s) were omitted by the per-result limit.`,
    );
  }
  if (dropped > 0) {
    lines.push(
      `Read is incomplete: ${String(dropped)} item(s) exceeded the result text budget. Request a narrower range to read them.`,
    );
  } else if (result.truncated && result.nextRange !== undefined) {
    const next = canonicalJsonString(JSON.parse(JSON.stringify(result.nextRange)) as JsonObject);
    lines.push(
      `Read is incomplete. Continue with range ${next}, or with {"kind":"CONTINUE","cursor":${JSON.stringify(next)}}.`,
    );
  } else if (result.truncated) {
    lines.push("Read is incomplete; request a narrower range to continue.");
  } else {
    lines.push("Coverage: complete for the requested range.");
  }
  return lines.join("\n");
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function safeOperationError(code: AttachmentReadOperationErrorCode) {
  return errorResult(code, `Attachment read failed: ${code}.`);
}
