import type { HistoryLookupOperations } from "@caelush/agent";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import { READ_HISTORY_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { defineCodingTool } from "./define-coding-tool.js";
import { projectReadHistorySecurityFacts } from "../security/security-facts.js";
import {
  errorResult,
  asOverlaySecurityFactsProjector,
  positiveBoundedInteger,
  successResult,
  type AgentToolResult,
} from "./result.js";

/**
 * `read_history` — read a bounded page of the original records a checkpoint replaced.
 *
 * ```text
 * sourceRef    an opaque reference the host emitted with a summary or a degraded checkpoint
 * cursor       the continuation the previous page returned
 * maxBytes     how much visible text this page may carry
 * ```
 *
 * ## Why this Tool exists at all
 *
 * A degraded continuation is only honest if the model can get the lost detail back. Before this Tool,
 * a checkpoint could carry a reference that nothing could resolve: the claim "the original records are
 * preserved" was true of the database and false of the product. The Tool is the read side of that
 * claim, and it is the reason a summary may replace history at all.
 *
 * ## What it will not do
 *
 * It cannot widen its own scope. The host binds the executing Session and Run when the Tool runs, so a
 * fabricated reference from another Session is refused rather than trusted. It also never returns a
 * raw record: the host projects each record to redacted, bounded visible text, so provider-native
 * reasoning, private replay envelopes and credentials have no path into the model.
 */
const inputSchema = {
  type: "object",
  properties: {
    sourceRef: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description:
        "Opaque source reference supplied with a summary or degraded checkpoint. Not a path.",
    },
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "Continuation token returned by a previous read_history page.",
    },
    maxBytes: {
      type: "integer",
      minimum: 1,
      maximum: 32_768,
      default: 8_192,
      description: "Maximum visible text bytes for this page; defaults to 8192.",
    },
  },
  required: ["sourceRef"],
  additionalProperties: false,
} as const;

const outputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    reason: { type: "string" },
    sourceRef: { type: "string" },
    integrity: { type: "string" },
    nextCursor: { type: "string" },
    bytesReturned: { type: "integer" },
    itemCount: { type: "integer" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          messageId: { type: "string" },
          sequence: { type: "integer" },
          role: { type: "string" },
          text: { type: "string" },
        },
        required: ["messageId", "sequence", "role", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

export function createReadHistoryTool(
  operations: HistoryLookupOperations | undefined,
): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "read_history",
    scheduling: { class: "READ_ONLY" },
    description: "Read an earlier conversation page referenced by a summary.",
    executionMode: "PARALLEL_SAFE",
    inputSchema,
    resultDetailsSchema: outputSchema,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as {
        sourceRef?: unknown;
        cursor?: unknown;
        maxBytes?: unknown;
      };
      if (typeof args.sourceRef !== "string" || args.sourceRef.trim().length === 0) {
        return errorResult("INVALID_REFERENCE", "Tool operation failed: INVALID_REFERENCE.");
      }
      let maxBytes: number;
      try {
        maxBytes = positiveBoundedInteger(args.maxBytes, 8_192, 32_768);
      } catch {
        return errorResult("INVALID_RANGE", "Tool operation failed: INVALID_RANGE.");
      }
      if (args.cursor !== undefined && typeof args.cursor !== "string") {
        return errorResult("INVALID_CURSOR", "Tool operation failed: INVALID_CURSOR.");
      }
      if (operations === undefined) {
        return errorResult("HISTORY_UNAVAILABLE", "Tool operation failed: HISTORY_UNAVAILABLE.");
      }

      const page = await operations.read(
        {
          sourceRef: args.sourceRef,
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          maxBytes,
        },
        // Scope comes from the execution identity the host attached to this invocation. A model can
        // name a reference; it cannot name a Session.
        { sessionId: input.identity.sessionId, runId: input.identity.runId },
        input.signal,
      );
      if (page.kind === "UNAVAILABLE") {
        return {
          content: `History source unavailable: ${page.reason}.`,
          details: { ok: false, error: "HISTORY_UNAVAILABLE", reason: page.reason },
          isError: true,
        };
      }
      const rendered = page.items
        .map((item) => `[${item.sequence} ${item.role}] ${item.text}`)
        .join("\n\n");
      return successResult(rendered.length === 0 ? "(no records in this page)" : rendered, {
        sourceRef: page.sourceRef,
        integrity: page.integrity,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        bytesReturned: page.byteCount,
        itemCount: page.items.length,
        items: page.items.map((item) => ({
          messageId: item.messageId,
          sequence: item.sequence,
          role: item.role,
          text: item.text,
        })),
      });
    },
  });

  return {
    tool,
    security: {
      riskLevel: "LOW",
      // Conversation history is not a filesystem capability: this Tool never receives a path and its
      // port is bound to the executing Session by the host. It reaches no host resource at all, so it
      // declares no capability and no runtime kind — the combination is `IN_PROCESS` by the security
      // vocabulary's own rule (capabilities empty ⇒ runtime kinds must be empty).
      requiredCapabilities: [],
      runtimeRequirements: { runtimeKinds: [] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectReadHistorySecurityFacts),
    promptSnippet: READ_HISTORY_PROMPT_SNIPPET,
  };
}
