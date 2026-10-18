import type { AIMessage, AIUserContent, ModelDescriptor } from "@caelush/ai";
import {
  AttachmentIdSchema,
  AttachmentModelContentReferenceSchema,
  AttachmentReadResultSchema,
} from "@caelush/protocol";
import type {
  AttachmentId,
  AttachmentModelContentReference,
  AttachmentReadRange,
  AttachmentReadResult,
} from "@caelush/protocol";
import type { ContextEnginePort, ContextPrepareInput, PreparedModelContext } from "@caelush/agent";
import {
  attachmentMarkerV2,
  type AgentAttachmentRefPart,
  type AgentUserMessage,
  type StoredAgentMessage,
} from "@caelush/agent";
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

/**
 * How many artifact/tool projections one Run keeps frozen.
 *
 * A frozen projection is the whole point of this layer: the bytes a model saw for an attachment must
 * never be recomputed, because rewriting an earlier message invalidates every cached token after it.
 */
const MAX_FROZEN_PROJECTIONS = 64;
/**
 * How much of one attachment is inlined on the first turn.
 *
 * Two steps and a byte ceiling give a real prefix (two PDF pages, two block ranges, two line blocks)
 * without knowing any format: the second step is the same `CONTINUE` range a model would send.
 */
const MAX_AUTO_READ_STEPS = 2;
const MAX_AUTO_PREFIX_BYTES = 96 * 1024;

interface FrozenProjection {
  readonly omitted: boolean;
  readonly content: readonly AIUserContent[];
  readonly tokenEstimate: number;
  readonly partial: boolean;
}

interface AttachmentContribution {
  readonly tokenEstimate: number;
  readonly itemCount: number;
  readonly droppedItems: number;
  readonly truncatedItems: number;
  readonly remainingTokens: number;
}

/** Safe public failure for a missing, mismatched, or corrupt attachment snapshot. */
export class AttachmentContextMaterializationError extends Error {
  constructor(readonly code: "PORT_UNAVAILABLE" | "SNAPSHOT_INVALID" | "REFERENCE_MISSING") {
    super(`Attachment context materialization failed (${code}).`);
    this.name = "AttachmentContextMaterializationError";
  }
}

/**
 * Add attachment content after the base Context plan has selected messages and budget.
 *
 * Two rules shape this layer:
 *
 * ```text
 * write once   an attachment projection is computed on its first turn and reused verbatim
 * append only  a Tool result's images follow it as a new user message, never inside the tool message
 * ```
 *
 * Recomputing a projection per turn looks harmless but rewrites an earlier message whenever the
 * remaining budget crosses the attachment size, which invalidates the provider prefix from that point
 * on. Freezing the first projection keeps the prompt an append-extension of its predecessor.
 */
export function createAttachmentAwareContextEngine(
  inner: ContextEnginePort,
  port?: AttachmentContextPort,
): ContextEnginePort {
  const frozen = new Map<string, Promise<FrozenProjection>>();

  function remember(
    key: string,
    factory: () => Promise<FrozenProjection>,
  ): Promise<FrozenProjection> {
    const cached = frozen.get(key);
    if (cached !== undefined) return cached;
    const promise = factory();
    frozen.set(key, promise);
    if (frozen.size > MAX_FROZEN_PROJECTIONS) {
      const oldest = frozen.keys().next().value;
      if (oldest !== undefined && oldest !== key) frozen.delete(oldest);
    }
    void promise.catch(() => {
      if (frozen.get(key) === promise) frozen.delete(key);
    });
    return promise;
  }

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

      let remaining = prepared.report.remainingTokens;
      let messages = prepared.messages;
      let tokenEstimate = 0;
      let itemCount = 0;
      let droppedItems = 0;
      let truncatedItems = 0;

      if (latestUser !== undefined) {
        if (port === undefined) {
          throw new AttachmentContextMaterializationError("PORT_UNAVAILABLE");
        }
        const contents = new Map<AttachmentId, readonly AIUserContent[]>();
        for (const part of latestUser.message.content) {
          if (part.type !== "ATTACHMENT_REF") continue;
          if (input.signal.aborted) throw createAbortError();
          const artifactId = AttachmentIdSchema.parse(part.artifactId);
          const entry = await remember(`artifact:${artifactId}`, () =>
            freezeAttachment({
              artifactId,
              port,
              model: input.model,
              signal: input.signal,
              owner: { kind: "SESSION", sessionId: input.identity.sessionId },
              remainingTokenBudget: remaining,
            }),
          );
          if (entry.omitted) {
            droppedItems += 1;
            contents.set(artifactId, omittedAttachmentNote(part));
            continue;
          }
          itemCount += 1;
          tokenEstimate += entry.tokenEstimate;
          if (entry.partial) truncatedItems += 1;
          remaining = Math.max(0, remaining - entry.tokenEstimate);
          contents.set(artifactId, entry.content);
        }
        messages = materializeSelectedAttachments(messages, latestUser.message.content, contents);
      }

      if (toolResults.length > 0 && input.model.capabilities.vision !== "UNSUPPORTED") {
        if (port === undefined) {
          throw new AttachmentContextMaterializationError("PORT_UNAVAILABLE");
        }
        const toolImages = new Map<
          string,
          { toolName: string; content: readonly AIUserContent[] }
        >();
        for (const stored of toolResults) {
          if (stored.message.type !== "TOOL_RESULT") continue;
          const entry = await remember(`tool:${stored.message.toolCallId}`, () =>
            freezeToolImages({
              message: stored.message as Extract<
                StoredAgentMessage["message"],
                { type: "TOOL_RESULT" }
              >,
              port,
              sessionId: input.identity.sessionId,
              signal: input.signal,
              remainingTokenBudget: remaining,
            }),
          );
          if (entry.omitted || entry.content.length === 0) continue;
          toolImages.set(stored.message.toolCallId, {
            toolName: stored.message.toolName,
            content: entry.content,
          });
          itemCount += 1;
          tokenEstimate += entry.tokenEstimate;
          remaining = Math.max(0, remaining - entry.tokenEstimate);
        }
        if (toolImages.size > 0) messages = appendToolImages(messages, toolImages);
      }

      return withAttachmentBudget(prepared, messages, {
        tokenEstimate,
        itemCount,
        droppedItems,
        truncatedItems,
        remainingTokens: remaining,
      });
    },
  });
}

function estimateAttachmentTextTokens(text: string): number {
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes === 0 ? 0 : Math.ceil(bytes / 3);
}

/**
 * Read the format-neutral beginning of one attachment and project it once.
 *
 * `AUTO` is what keeps this function free of format knowledge: the processor decides which page,
 * block, line range or sheet starts the document, and returns the range that continues it.
 */
async function freezeAttachment(input: {
  readonly artifactId: AttachmentId;
  readonly port: AttachmentContextPort;
  readonly model: ModelDescriptor;
  readonly signal: AbortSignal;
  readonly owner: {
    readonly kind: "SESSION";
    readonly sessionId: ContextPrepareInput["identity"]["sessionId"];
  };
  readonly remainingTokenBudget: number;
}): Promise<FrozenProjection> {
  const snapshot = await input.port.readSnapshot({
    artifactId: input.artifactId,
    owner: input.owner,
    signal: input.signal,
  });
  assertSnapshotMatches(input.artifactId, snapshot);
  const readResults: AttachmentReadResult[] = [];
  let nextRange: AttachmentReadRange | undefined = automaticRanges(snapshot, input.model)[0];
  let prefixBytes = 0;
  while (
    nextRange !== undefined &&
    readResults.length < MAX_AUTO_READ_STEPS &&
    prefixBytes < MAX_AUTO_PREFIX_BYTES
  ) {
    if (input.signal.aborted) throw createAbortError();
    const result = await snapshot.contentReference.read({ range: nextRange, signal: input.signal });
    if (
      result.artifactId !== input.artifactId ||
      result.sha256 !== snapshot.manifest.sha256 ||
      result.processorVersion !== snapshot.manifest.processorVersion
    ) {
      throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
    }
    readResults.push(
      input.model.capabilities.vision === "UNSUPPORTED" ? withoutImages(result) : result,
    );
    prefixBytes += result.outputBytes;
    nextRange =
      result.truncated && result.nextRange !== undefined
        ? { kind: "CONTINUE", cursor: JSON.stringify(result.nextRange) }
        : undefined;
  }
  if (readResults.length === 0) return omittedProjection();

  const projection = projectAttachmentContext({
    attachments: [{ descriptor: snapshot.descriptor, manifest: snapshot.manifest, readResults }],
    remainingTokenBudget: input.remainingTokenBudget,
    estimateTokens: estimateAttachmentTextTokens,
  });
  return toFrozenProjection(projection.attachments[0]);
}

async function freezeToolImages(input: {
  readonly message: Extract<StoredAgentMessage["message"], { type: "TOOL_RESULT" }>;
  readonly port: AttachmentContextPort;
  readonly sessionId: ContextPrepareInput["identity"]["sessionId"];
  readonly signal: AbortSignal;
  readonly remainingTokenBudget: number;
}): Promise<FrozenProjection> {
  const documents: AttachmentContextDocument[] = [];
  for (const reference of input.message.attachmentReferences) {
    if (input.signal.aborted) throw createAbortError();
    documents.push(
      await readReferencedImage({
        reference,
        port: input.port,
        sessionId: input.sessionId,
        signal: input.signal,
      }),
    );
  }
  if (documents.length === 0) return omittedProjection();

  const projection = projectAttachmentContext({
    attachments: documents,
    remainingTokenBudget: input.remainingTokenBudget,
    estimateTokens: estimateAttachmentTextTokens,
  });
  if (projection.attachments.some((attachment) => attachment.omitted)) {
    return omittedProjection();
  }
  return {
    omitted: projection.attachments.length === 0,
    content: Object.freeze(projection.attachments.flatMap((attachment) => attachment.content)),
    tokenEstimate: projection.tokenEstimate,
    partial: projection.attachments.some((attachment) => attachment.partial),
  };
}

/** The only placement rule: a vision-capable model gets the format-neutral beginning. */
function automaticRanges(
  snapshot: AttachmentContextSnapshot,
  model: ModelDescriptor,
): readonly AttachmentReadRange[] {
  if (snapshot.manifest.kind === "IMAGE" && model.capabilities.vision === "UNSUPPORTED") return [];
  return [{ kind: "AUTO" }];
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

/**
 * Put a Tool result's images in a new user message after the whole Tool batch.
 *
 * The OpenAI-compatible dialect refuses images inside a `tool` message, and inserting a message
 * between two Tool results would break Tool-call pairing. Appending after the last consecutive Tool
 * message is the one placement both dialects accept.
 */
/**
 * Put each Tool batch's images in a new user message after that batch.
 *
 * The OpenAI-compatible dialect refuses images inside a `tool` message, and inserting a message
 * between two Tool results would break Tool-call pairing. Appending after the last Tool result of the
 * batch is the one placement both dialects accept.
 *
 * Placement is per batch, not "after the newest batch", because the projection is rebuilt on every
 * turn: a global tail insertion would move an older batch's images forward as soon as a newer tool
 * call appeared, rewriting the prompt prefix and losing every cached token after it.
 */
function appendToolImages(
  messages: readonly AIMessage[],
  images: ReadonlyMap<
    string,
    { readonly toolName: string; readonly content: readonly AIUserContent[] }
  >,
): readonly AIMessage[] {
  const next: AIMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    next.push(message);
    if (message.role !== "tool") continue;
    if (messages[index + 1]?.role === "tool") continue;

    let start = index;
    while (start > 0 && messages[start - 1]?.role === "tool") start -= 1;
    const content: AIUserContent[] = [];
    for (let position = start; position <= index; position += 1) {
      const batchMessage = messages[position];
      if (batchMessage?.role !== "tool") continue;
      const entry = images.get(batchMessage.toolCallId);
      if (entry === undefined) continue;
      content.push({
        type: "text",
        text: `[attachment images returned by ${entry.toolName} call ${batchMessage.toolCallId}]`,
      });
      content.push(...entry.content);
    }
    if (content.length > 0) next.push({ role: "user", content: Object.freeze(content) });
  }
  if (next.length === messages.length) {
    throw new AttachmentContextMaterializationError("REFERENCE_MISSING");
  }
  return Object.freeze(next);
}

function materializeSelectedAttachments(
  messages: readonly AIMessage[],
  refs: AgentUserMessage["content"],
  contents: ReadonlyMap<AttachmentId, readonly AIUserContent[]>,
): readonly AIMessage[] {
  const referenceParts = refs.filter(
    (part): part is AgentAttachmentRefPart => part.type === "ATTACHMENT_REF",
  );
  if (referenceParts.length === 0) return messages;
  const result = [...messages];
  for (const reference of referenceParts) {
    const artifactId = AttachmentIdSchema.parse(reference.artifactId);
    const content = contents.get(artifactId);
    if (content === undefined) {
      throw new AttachmentContextMaterializationError("REFERENCE_MISSING");
    }
    if (content.length === 0) continue;
    const marker = attachmentMarkerV2(reference);
    let replaced = false;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const message = result[index];
      if (message === undefined || message.role !== "user") continue;
      const nextContent = replaceMarker(message.content, marker, content);
      if (nextContent === undefined) continue;
      result[index] = { role: "user", content: nextContent };
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
  contribution: AttachmentContribution,
): PreparedModelContext {
  if (contribution.tokenEstimate === 0 && contribution.droppedItems === 0) {
    return { ...prepared, messages };
  }
  return {
    ...prepared,
    messages,
    report: {
      ...prepared.report,
      estimatedInputTokens: prepared.report.estimatedInputTokens + contribution.tokenEstimate,
      remainingTokens: contribution.remainingTokens,
      contributions: [
        ...prepared.report.contributions,
        {
          providerId: "conversation.attachments",
          tokenEstimate: contribution.tokenEstimate,
          itemCount: contribution.itemCount,
          droppedItems: contribution.droppedItems,
          truncatedItems: contribution.truncatedItems,
        },
      ],
    },
  };
}

function toFrozenProjection(
  projection: AttachmentContextDocumentProjection | undefined,
): FrozenProjection {
  if (projection === undefined) {
    throw new AttachmentContextMaterializationError("SNAPSHOT_INVALID");
  }
  return Object.freeze({
    omitted: projection.omitted,
    content: projection.content,
    tokenEstimate: projection.tokenEstimate,
    partial: projection.partial,
  });
}

function omittedProjection(): FrozenProjection {
  return Object.freeze({
    omitted: true,
    content: Object.freeze([]),
    tokenEstimate: 0,
    partial: false,
  });
}

/**
 * Replace an attachment that could not be inlined with an instruction the model can act on.
 *
 * Keeping the bare marker would leave the model with an id and no hint; this keeps the message
 * deterministic (it is frozen with the rest of the projection) while naming the one read that works.
 */
function omittedAttachmentNote(part: AgentAttachmentRefPart): readonly AIUserContent[] {
  const label = part.label === undefined ? "attachment" : JSON.stringify(part.label);
  return Object.freeze([
    {
      type: "text",
      text: `[${label} (${part.artifactId}) is not inlined; call read_attachment with range {"kind":"AUTO"} to read it.]`,
    },
  ]);
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

function withoutImages(result: AttachmentReadResult) {
  return { ...result, items: result.items.filter((item) => item.type !== "IMAGE") };
}

function createAbortError(): Error {
  const error = new Error("Attachment context materialization was cancelled.");
  error.name = "AbortError";
  return error;
}
