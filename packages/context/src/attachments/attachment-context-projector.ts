import type { AIUserContent } from "@caelush/ai";
import {
  AttachmentIdSchema,
  AttachmentProcessingManifestSchema,
  AttachmentReadResultSchema,
} from "@caelush/protocol";
import type {
  AttachmentId,
  AttachmentProcessingManifest,
  AttachmentReadLocation,
  AttachmentReadRange,
  AttachmentReadResult,
} from "@caelush/protocol";

/** Conservative non-zero estimate when the host has no model-specific image estimator. */
export const DEFAULT_ATTACHMENT_IMAGE_TOKEN_ESTIMATE = 1_024;

export interface AttachmentContextDocument {
  readonly descriptor: {
    readonly artifactId: string;
    readonly name: string;
    readonly mediaType: string;
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly manifest: AttachmentProcessingManifest;
  readonly readResults: readonly AttachmentReadResult[];
}

export interface AttachmentContextProjectionInput {
  readonly attachments: readonly AttachmentContextDocument[];
  readonly remainingTokenBudget: number;
  readonly estimateTokens: (text: string) => number;
  readonly estimateImageTokens?: (input: {
    readonly width: number;
    readonly height: number;
    readonly mediaType: string;
  }) => number;
}

export interface AttachmentContextIncludedRange {
  readonly range: AttachmentReadRange;
  readonly locations: readonly AttachmentReadLocation[];
}

export interface AttachmentContextDocumentProjection {
  readonly artifactId: AttachmentId;
  readonly content: readonly AIUserContent[];
  readonly tokenEstimate: number;
  readonly omitted: boolean;
  readonly includedRanges: readonly AttachmentContextIncludedRange[];
}

export interface AttachmentContextProjection {
  readonly attachments: readonly AttachmentContextDocumentProjection[];
  readonly omittedIds: readonly AttachmentId[];
  readonly includedRanges: readonly (AttachmentContextIncludedRange & {
    readonly artifactId: AttachmentId;
  })[];
  readonly tokenEstimate: number;
  readonly remainingTokenBudget: number;
}

/** A bounded, deterministic projection of parser snapshots into model-ready content. */
export class AttachmentContextProjectionError extends Error {
  constructor(readonly code: "INVALID_SNAPSHOT" | "INVALID_ESTIMATE") {
    super(`Attachment context projection failed (${code}).`);
    this.name = "AttachmentContextProjectionError";
  }
}

/**
 * Select complete attachment reads that fit one shared budget.
 *
 * A partial parser result is omitted as a whole. This leaves the durable reference available to
 * `read_attachment` without presenting a clipped document as though it were complete.
 */
export function projectAttachmentContext(
  input: AttachmentContextProjectionInput,
): AttachmentContextProjection {
  if (
    !Number.isSafeInteger(input.remainingTokenBudget) ||
    input.remainingTokenBudget < 0 ||
    typeof input.estimateTokens !== "function"
  ) {
    throw new AttachmentContextProjectionError("INVALID_ESTIMATE");
  }

  let remaining = input.remainingTokenBudget;
  let total = 0;
  const attachments: AttachmentContextDocumentProjection[] = [];
  const omittedIds: AttachmentId[] = [];
  const includedRanges: (AttachmentContextIncludedRange & { artifactId: AttachmentId })[] = [];

  for (const document of input.attachments) {
    const artifactId = validateDocument(document);
    const converted = convertReadResults(document, input.estimateTokens, input.estimateImageTokens);
    if (!converted.complete || converted.tokenEstimate > remaining) {
      omittedIds.push(artifactId);
      attachments.push(
        Object.freeze({
          artifactId,
          content: Object.freeze([]),
          tokenEstimate: 0,
          omitted: true,
          includedRanges: Object.freeze([]),
        }),
      );
      continue;
    }

    remaining -= converted.tokenEstimate;
    total += converted.tokenEstimate;
    attachments.push(
      Object.freeze({
        artifactId,
        content: Object.freeze(converted.content),
        tokenEstimate: converted.tokenEstimate,
        omitted: false,
        includedRanges: Object.freeze(converted.includedRanges),
      }),
    );
    for (const range of converted.includedRanges) {
      includedRanges.push(Object.freeze({ ...range, artifactId }));
    }
  }

  return Object.freeze({
    attachments: Object.freeze(attachments),
    omittedIds: Object.freeze(omittedIds),
    includedRanges: Object.freeze(includedRanges),
    tokenEstimate: total,
    remainingTokenBudget: remaining,
  });
}

function validateDocument(document: AttachmentContextDocument): AttachmentId {
  try {
    const artifactId = AttachmentIdSchema.parse(document.descriptor.artifactId);
    const manifest = AttachmentProcessingManifestSchema.parse(document.manifest);
    if (
      manifest.artifactId !== artifactId ||
      manifest.sha256 !== document.descriptor.sha256 ||
      manifest.mediaType !== document.descriptor.mediaType ||
      manifest.processorVersion.length === 0
    ) {
      throw new AttachmentContextProjectionError("INVALID_SNAPSHOT");
    }
    for (const result of document.readResults) {
      const parsed = AttachmentReadResultSchema.parse(result);
      if (
        parsed.artifactId !== artifactId ||
        parsed.sha256 !== manifest.sha256 ||
        parsed.processorVersion !== manifest.processorVersion
      ) {
        throw new AttachmentContextProjectionError("INVALID_SNAPSHOT");
      }
    }
    return artifactId;
  } catch (error) {
    if (error instanceof AttachmentContextProjectionError) throw error;
    throw new AttachmentContextProjectionError("INVALID_SNAPSHOT");
  }
}

function convertReadResults(
  document: AttachmentContextDocument,
  estimateTokens: (text: string) => number,
  estimateImageTokens: AttachmentContextProjectionInput["estimateImageTokens"],
): {
  readonly complete: boolean;
  readonly content: AIUserContent[];
  readonly tokenEstimate: number;
  readonly includedRanges: AttachmentContextIncludedRange[];
} {
  const content: AIUserContent[] = [];
  const includedRanges: AttachmentContextIncludedRange[] = [];
  let tokenEstimate = 0;

  for (const result of document.readResults) {
    if (result.truncated || result.nextRange !== undefined) {
      return { complete: false, content: [], tokenEstimate: 0, includedRanges: [] };
    }
    const locations: AttachmentReadLocation[] = [];
    for (const item of result.items) {
      locations.push(item.location);
      if (item.type === "IMAGE") {
        let estimate: number;
        try {
          estimate =
            estimateImageTokens?.({
              width: item.width,
              height: item.height,
              mediaType: item.mediaType,
            }) ?? DEFAULT_ATTACHMENT_IMAGE_TOKEN_ESTIMATE;
        } catch {
          throw new AttachmentContextProjectionError("INVALID_ESTIMATE");
        }
        if (!Number.isSafeInteger(estimate) || estimate < 1) {
          throw new AttachmentContextProjectionError("INVALID_ESTIMATE");
        }
        tokenEstimate += estimate;
        content.push({ type: "image", mediaType: item.mediaType, data: item.data });
        continue;
      }

      const text = item.type === "CELL" ? formatCell(item) : item.text;
      const labeled = `[${document.descriptor.name}; ${formatLocation(item.location)}]\n${text}`;
      let estimate: number;
      try {
        estimate = estimateTokens(labeled);
      } catch {
        throw new AttachmentContextProjectionError("INVALID_ESTIMATE");
      }
      if (!Number.isSafeInteger(estimate) || estimate < 0) {
        throw new AttachmentContextProjectionError("INVALID_ESTIMATE");
      }
      tokenEstimate += estimate;
      content.push({ type: "text", text: labeled });
    }
    includedRanges.push({ range: result.range, locations: Object.freeze(locations) });
  }

  return { complete: document.readResults.length > 0, content, tokenEstimate, includedRanges };
}

function formatCell(
  item: Extract<AttachmentReadResult["items"][number], { type: "CELL" }>,
): string {
  const formula = item.formula === undefined ? "" : ` formula=${JSON.stringify(item.formula)}`;
  const value = item.value === undefined ? "" : ` value=${JSON.stringify(item.value)}`;
  return `${formula}${value}`.trim();
}

function formatLocation(location: AttachmentReadLocation): string {
  switch (location.kind) {
    case "TEXT_LINES":
      return `lines ${location.startLine}-${location.endLine}`;
    case "PDF_PAGE":
      return `page ${location.pageNumber}`;
    case "DOCX_BLOCK":
      return `block ${location.blockIndex}`;
    case "DOCX_TABLE_CELL":
      return `table ${location.blockIndex}, row ${location.rowIndex + 1}, column ${location.columnIndex + 1}`;
    case "DOCX_IMAGE":
      return `image ${location.imageIndex + 1}`;
    case "XLSX_CELL":
      return `${location.sheetName}!${location.address}`;
    case "XLSX_IMAGE":
      return `${location.sheetName}!${location.cellAddress}`;
    case "MANIFEST":
      return "manifest";
    case "IMAGE":
      return "image";
  }
}
