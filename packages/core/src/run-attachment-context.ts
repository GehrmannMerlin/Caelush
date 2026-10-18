import type { AIMessage, AIUserContent, ModelDescriptor } from "@caelush/ai";
import {
  AttachmentIdSchema,
  AttachmentModelContentReferenceSchema,
  AttachmentReadResultSchema,
} from "@caelush/protocol";
import type {
  AttachmentId,
  AttachmentModelContentReference,
  AttachmentReadResult,
} from "@caelush/protocol";
import type { ContextEnginePort, ContextPrepareInput, PreparedModelContext } from "@caelush/agent";
import {
  attachmentMarkerV2,
  type AgentAttachmentRefPart,
  type AgentUserMessage,
  type StoredAgentMessage,
} from "@caelush/agent";
import type { AttachmentReadRange } from "@caelush/protocol";
import {
  projectAttachmentContext,
  type AttachmentContextDocument,
  type AttachmentContextDocumentProjection,
} from "@caelush/context";

import type {
  AttachmentContextPort,
  AttachmentContextSnapshot,
} from "./attachment-context-port.js";
import { semanticEqual } from "./semantic-equality.js";

const AUTO_TEXT_MAX_BYTES = 64 * 1024;
const AUTO_DOCX_MAX_BYTES = 256 * 1024;
const AUTO_DOCX_MAX_BLOCKS = 50;
const AUTO_PDF_MAX_PAGES = 2;
const AUTO_XLSX_MAX_CELLS = 500;

/** Safe public failure for a missing, mismatched, or corrupt attachment snapshot. */
export class AttachmentContextMaterializationError extends Error {
  constructor(readonly code: "PORT_UNAVAILABLE" | "SNAPSHOT_INVALID" | "REFERENCE_MISSING") {
    super(`Attachment context materialization failed (${code}).`);
    this.name = "AttachmentContextMaterializationError";
  }
}

/** Add attachment content after the base Context plan has selected messages and budget. */
export function createAttachmentAwareContextEngine(
  inner: ContextEnginePort,
  port?: AttachmentContextPort,
): ContextEnginePort {
  return Object.freeze({
    async prepare(input: ContextPrepareInput): Promise<PreparedModelContext> {
      const prepared = await inner.prepare(input);
      const currentTurn = input.conversation.turns.find(
        (turn) => turn.id === input.conversation.currentTurnId,
      );
      if (currentTurn === undefined) return prepared;
      const selectedIds =
        prepared.selectedMessageIds === undefined
          ? undefined
          : new Set(prepared.selectedMessageIds);
      const userMessages = currentTurn.messages.filter(
        (stored): stored is StoredAgentMessage<AgentUserMessage> =>
          stored.message.type === "USER" &&
          stored.message.audience.model &&
          stored.modelProjectionVersion === 2 &&
          (selectedIds === undefined || selectedIds.has(stored.message.id)),
      );
      const latestUser = [...userMessages]
        .reverse()
        .find((stored) => stored.message.content.some((part) => part.type === "ATTACHMENT_REF"));
      const toolResults = currentTurn.messages.filter(
        (stored) =>
          stored.message.type === "TOOL_RESULT" &&
          stored.message.audience.model &&
          stored.message.attachmentReferences.length > 0 &&
          (selectedIds === undefined || selectedIds.has(stored.message.id)),
      );
      if (latestUser === undefined && toolResults.length === 0) return prepared;

      const projections: ReturnType<typeof projectAttachmentContext>[] = [];
      let remainingTokenBudget = prepared.report.remainingTokens;
      let messages = prepared.messages;
      if (latestUser !== undefined) {
        if (port === undefined) {
          throw new AttachmentContextMaterializationError("PORT_UNAVAILABLE");
        }
        const documents = await readAutomaticAttachmentContent({
          message: latestUser.message,
          port,
          model: input.model,
          signal: input.signal,
          owner: { kind: "SESSION", sessionId: input.identity.sessionId },
        });
        const projection = projectAttachmentContext({
          attachments: documents,
          remainingTokenBudget,
          estimateTokens: estimateAttachmentTextTokens,
        });
        projections.push(projection);
        remainingTokenBudget = projection.remainingTokenBudget;
        const projectionById = new Map<AttachmentId, AttachmentContextDocumentProjection>(
          projection.attachments.map((attachment) => [attachment.artifactId, attachment]),
        );
        messages = materializeSelectedAttachments(
          messages,
          latestUser.message.content,
          projectionById,
        );
      }

      if (toolResults.length > 0 && input.model.capabilities.vision !== "UNSUPPORTED") {
        if (port === undefined) {
          throw new AttachmentContextMaterializationError("PORT_UNAVAILABLE");
        }
        for (const stored of toolResults) {
          if (stored.message.type !== "TOOL_RESULT") continue;
          for (const reference of stored.message.attachmentReferences) {
            const document = await readReferencedImage({
              reference,
              port,
              sessionId: input.identity.sessionId,
              signal: input.signal,
            });
            const projection = projectAttachmentContext({
              attachments: [document],
              remainingTokenBudget,
              estimateTokens: estimateAttachmentTextTokens,
            });
            projections.push(projection);
            remainingTokenBudget = projection.remainingTokenBudget;
            const projected = projection.attachments[0];
            if (projected === undefined) {
              throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
            }
            if (projected.omitted || projected.content.length === 0) continue;
            messages = appendToolAttachmentContent(
              messages,
              stored.message.toolCallId,
              projected.content,
            );
          }
        }
      }

      return withAttachmentBudget(
        prepared,
        messages,
        combineAttachmentProjections(projections, remainingTokenBudget),
      );
    },
  });
}

function estimateAttachmentTextTokens(text: string): number {
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes === 0 ? 0 : Math.ceil(bytes / 3);
}

async function readAutomaticAttachmentContent(input: {
  readonly message: AgentUserMessage;
  readonly port: AttachmentContextPort;
  readonly model: ModelDescriptor;
  readonly signal: AbortSignal;
  readonly owner: {
    readonly kind: "SESSION";
    readonly sessionId: ContextPrepareInput["identity"]["sessionId"];
  };
}): Promise<AttachmentContextDocument[]> {
  const documents: AttachmentContextDocument[] = [];
  for (const part of input.message.content) {
    if (part.type !== "ATTACHMENT_REF") continue;
    if (input.signal.aborted) throw createAbortError();
    const artifactId = AttachmentIdSchema.parse(part.artifactId);
    const snapshot = await input.port.readSnapshot({
      artifactId,
      owner: input.owner,
      signal: input.signal,
    });
    assertSnapshotMatches(artifactId, snapshot);
    const ranges = automaticRanges(snapshot, input.model);
    const readResults = [];
    for (const range of ranges) {
      if (input.signal.aborted) throw createAbortError();
      const result = await snapshot.contentReference.read({ range, signal: input.signal });
      if (
        result.artifactId !== artifactId ||
        result.sha256 !== snapshot.manifest.sha256 ||
        result.processorVersion !== snapshot.manifest.processorVersion
      ) {
        throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
      }
      readResults.push(
        input.model.capabilities.vision === "UNSUPPORTED" ? withoutImages(result) : result,
      );
    }
    documents.push({ descriptor: snapshot.descriptor, manifest: snapshot.manifest, readResults });
  }
  return documents;
}

async function readReferencedImage(input: {
  readonly reference: AttachmentModelContentReference;
  readonly port: AttachmentContextPort;
  readonly sessionId: ContextPrepareInput["identity"]["sessionId"];
  readonly signal: AbortSignal;
}): Promise<AttachmentContextDocument> {
  let reference: AttachmentModelContentReference;
  try {
    reference = AttachmentModelContentReferenceSchema.parse(input.reference);
  } catch {
    throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
  }
  if (input.signal.aborted) throw createAbortError();
  const snapshot = await input.port.readSnapshot({
    artifactId: reference.artifactId,
    owner: { kind: "SESSION", sessionId: input.sessionId },
    signal: input.signal,
  });
  assertSnapshotMatches(reference.artifactId, snapshot);
  if (snapshot.manifest.sha256 !== reference.sha256) {
    throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
  }
  if (input.signal.aborted) throw createAbortError();
  let result: AttachmentReadResult;
  try {
    result = AttachmentReadResultSchema.parse(
      await snapshot.contentReference.read({ range: reference.range, signal: input.signal }),
    );
  } catch {
    throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
  }
  if (
    result.artifactId !== reference.artifactId ||
    result.sha256 !== reference.sha256 ||
    result.processorVersion !== snapshot.manifest.processorVersion ||
    !semanticEqual(result.range, reference.range)
  ) {
    throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
  }
  const image = result.items.find(
    (item): item is Extract<AttachmentReadResult["items"][number], { readonly type: "IMAGE" }> =>
      item.type === "IMAGE" && semanticEqual(item.location, reference.location),
  );
  if (image === undefined) {
    throw new AttachmentContextMaterializationError("REFERENCE_MISSING");
  }
  if (image.mediaType !== reference.mediaType) {
    throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
  }
  return {
    descriptor: snapshot.descriptor,
    manifest: snapshot.manifest,
    readResults: [{ ...result, items: [image] }],
  };
}

function appendToolAttachmentContent(
  messages: readonly AIMessage[],
  toolCallId: string,
  content: readonly AIUserContent[],
): readonly AIMessage[] {
  const matching = messages
    .map((message, index) => ({ message, index }))
    .filter(
      (
        entry,
      ): entry is {
        readonly message: Extract<AIMessage, { readonly role: "tool" }>;
        readonly index: number;
      } => entry.message.role === "tool" && entry.message.toolCallId === toolCallId,
    );
  if (matching.length !== 1) {
    throw new AttachmentContextMaterializationError("REFERENCE_MISSING");
  }
  const target = matching[0];
  if (target === undefined) throw new AttachmentContextMaterializationError("REFERENCE_MISSING");
  const existing =
    typeof target.message.content === "string"
      ? target.message.content.length === 0
        ? []
        : [{ type: "text" as const, text: target.message.content }]
      : [...target.message.content];
  const next = [...messages];
  next[target.index] = {
    ...target.message,
    content: Object.freeze([...existing, ...content]),
  };
  return Object.freeze(next);
}

function automaticRanges(
  snapshot: AttachmentContextSnapshot,
  model: ModelDescriptor,
): readonly AttachmentReadRange[] {
  const manifest = snapshot.manifest;
  if (manifest.kind === "TEXT") {
    return snapshot.descriptor.byteLength <= AUTO_TEXT_MAX_BYTES && manifest.lineCount <= 500
      ? [{ kind: "TEXT_LINES", startLine: 1, lineCount: Math.max(1, manifest.lineCount) }]
      : [];
  }
  if (manifest.kind === "IMAGE") {
    return model.capabilities.vision === "UNSUPPORTED" ? [] : [{ kind: "IMAGE" }];
  }
  if (manifest.kind === "PDF") {
    return manifest.pageCount <= AUTO_PDF_MAX_PAGES
      ? manifest.pages.map((page) => ({ kind: "PDF_PAGE", pageNumber: page.pageNumber }))
      : [];
  }
  if (manifest.kind === "DOCX") {
    return snapshot.descriptor.byteLength <= AUTO_DOCX_MAX_BYTES &&
      manifest.blockCount > 0 &&
      manifest.blockCount <= AUTO_DOCX_MAX_BLOCKS
      ? [{ kind: "DOCX_BLOCKS", startIndex: 0, blockCount: manifest.blockCount }]
      : [];
  }
  if (manifest.kind === "XLSX") {
    const visible = manifest.sheets.filter((sheet) => sheet.state === "VISIBLE");
    const totalCells = visible.reduce((sum, sheet) => sum + sheet.rowCount * sheet.columnCount, 0);
    if (visible.length === 0 || totalCells > AUTO_XLSX_MAX_CELLS) return [];
    return visible.map((sheet) => ({
      kind: "XLSX_RANGE" as const,
      sheetName: sheet.name,
      range: `A1:${columnName(Math.max(1, sheet.columnCount))}${Math.max(1, sheet.rowCount)}`,
    }));
  }
  return [];
}

function materializeSelectedAttachments(
  messages: readonly AIMessage[],
  refs: AgentUserMessage["content"],
  projectionById: ReadonlyMap<
    import("@caelush/protocol").AttachmentId,
    AttachmentContextDocumentProjection
  >,
): readonly AIMessage[] {
  const referenceParts = refs.filter(
    (part): part is AgentAttachmentRefPart => part.type === "ATTACHMENT_REF",
  );
  if (referenceParts.length === 0) return messages;
  const result = [...messages];
  for (const reference of referenceParts) {
    const artifactId = AttachmentIdSchema.parse(reference.artifactId);
    const projection = projectionById.get(artifactId);
    if (projection === undefined)
      throw new AttachmentContextMaterializationError("REFERENCE_MISSING");
    if (projection.omitted || projection.content.length === 0) continue;
    const marker = attachmentMarkerV2(reference);
    let replaced = false;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const message = result[index];
      if (message === undefined || message.role !== "user") continue;
      const content = replaceMarker(message.content, marker, projection.content);
      if (content === undefined) continue;
      result[index] = { role: "user", content };
      replaced = true;
      break;
    }
    if (!replaced) throw new AttachmentContextMaterializationError("REFERENCE_MISSING");
  }
  return Object.freeze(result);
}

function replaceMarker(
  source: string | readonly AIUserContent[],
  marker: string,
  replacement: readonly AIUserContent[],
): string | readonly AIUserContent[] | undefined {
  if (typeof source !== "string") {
    const textIndex = source.findIndex(
      (part) => part.type === "text" && part.text.includes(marker),
    );
    if (textIndex < 0) return undefined;
    const part = source[textIndex];
    if (part?.type !== "text") return undefined;
    const index = part.text.indexOf(marker);
    const before = part.text.slice(0, index);
    const after = part.text.slice(index + marker.length);
    const result = [...source.slice(0, textIndex)];
    if (before.length > 0) result.push({ type: "text", text: before });
    result.push(...replacement);
    if (after.length > 0) result.push({ type: "text", text: after });
    result.push(...source.slice(textIndex + 1));
    return Object.freeze(result);
  }
  const index = source.indexOf(marker);
  if (index < 0) return undefined;
  const parts: AIUserContent[] = [];
  const before = source.slice(0, index);
  const after = source.slice(index + marker.length);
  if (before.length > 0) parts.push({ type: "text", text: before });
  parts.push(...replacement);
  if (after.length > 0) parts.push({ type: "text", text: after });
  return Object.freeze(parts);
}

function withAttachmentBudget(
  prepared: PreparedModelContext,
  messages: readonly AIMessage[],
  projection: Pick<
    ReturnType<typeof projectAttachmentContext>,
    "attachments" | "omittedIds" | "tokenEstimate" | "remainingTokenBudget"
  >,
): PreparedModelContext {
  if (projection.tokenEstimate === 0 && projection.omittedIds.length === 0) {
    return { ...prepared, messages };
  }
  const contribution = {
    providerId: "conversation.attachments",
    tokenEstimate: projection.tokenEstimate,
    itemCount: projection.attachments.filter((attachment) => !attachment.omitted).length,
    droppedItems: projection.omittedIds.length,
    truncatedItems: 0,
  };
  return {
    ...prepared,
    messages,
    report: {
      ...prepared.report,
      estimatedInputTokens: prepared.report.estimatedInputTokens + projection.tokenEstimate,
      remainingTokens: projection.remainingTokenBudget,
      contributions: [...prepared.report.contributions, contribution],
    },
  };
}

function combineAttachmentProjections(
  projections: readonly ReturnType<typeof projectAttachmentContext>[],
  remainingTokenBudget: number,
): Pick<
  ReturnType<typeof projectAttachmentContext>,
  "attachments" | "omittedIds" | "tokenEstimate" | "remainingTokenBudget"
> {
  return {
    attachments: projections.flatMap((projection) => projection.attachments),
    omittedIds: projections.flatMap((projection) => projection.omittedIds),
    tokenEstimate: projections.reduce((sum, projection) => sum + projection.tokenEstimate, 0),
    remainingTokenBudget,
  };
}

function assertSnapshotMatches(
  artifactId: AttachmentId,
  snapshot: AttachmentContextSnapshot,
): void {
  if (
    snapshot.descriptor.artifactId !== artifactId ||
    snapshot.manifest.artifactId !== artifactId ||
    snapshot.contentReference.artifactId !== artifactId ||
    snapshot.descriptor.sha256 !== snapshot.manifest.sha256 ||
    snapshot.contentReference.sha256 !== snapshot.manifest.sha256 ||
    snapshot.descriptor.mediaType !== snapshot.manifest.mediaType ||
    snapshot.descriptor.processorVersion !== snapshot.manifest.processorVersion
  ) {
    throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
  }
}

function withoutImages(result: import("@caelush/protocol").AttachmentReadResult) {
  return { ...result, items: result.items.filter((item) => item.type !== "IMAGE") };
}

function columnName(column: number): string {
  let current = column;
  let name = "";
  while (current > 0) {
    current -= 1;
    name = String.fromCharCode(65 + (current % 26)) + name;
    current = Math.floor(current / 26);
  }
  return name;
}

function createAbortError(): Error {
  const error = new Error("Attachment context materialization was cancelled.");
  error.name = "AbortError";
  return error;
}
