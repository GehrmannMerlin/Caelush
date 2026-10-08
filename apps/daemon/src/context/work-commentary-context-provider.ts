import {
  createContextItemId,
  createContextSourceId,
  createContextSourceItem,
  type ContextSourceInput,
  type ContextSourceProvider,
} from "@caelush/agent";
import { projectAgentAssistantTextItems } from "@caelush/agent";
import type { AgentAssistantMessage, AgentToolResultMessage } from "@caelush/agent";
import type { VerificationCheckStatus } from "@caelush/protocol";
import type { CaelushStorage } from "@caelush/storage";

const SOURCE_ID = createContextSourceId("daemon.work-commentary-state");
const SOURCE_VERSION = "work-commentary-state-v2";
const MAX_RECENT_TOOL_RESULTS = 6;
const MAX_CONTEXT_BYTES = 4 * 1024;

type WorkCommentaryStorage = Pick<
  CaelushStorage,
  "observations" | "toolInvocations" | "verification"
>;

interface OrderedMessage {
  readonly sequence: number;
  readonly message: AgentAssistantMessage | AgentToolResultMessage;
}

/**
 * Build a small, deterministic progress cue from committed Run history.
 *
 * The provider intentionally copies no Tool arguments, result text, or raw Observation content.
 * It validates recent observation references against the authoritative read-only repositories and
 * tells the model only which records are safe to treat as completed observations. The actual
 * evidence remains in the selected canonical conversation.
 */
export function createWorkCommentaryContextProvider(options: {
  readonly storage: WorkCommentaryStorage;
}): ContextSourceProvider {
  return Object.freeze({
    id: SOURCE_ID,
    async collect(input: ContextSourceInput) {
      const messages = input.conversation.turns
        .flatMap((turn) => turn.messages)
        .filter((stored) => stored.message.runId === input.identity.runId)
        .map((stored): OrderedMessage => ({
          sequence: stored.sequence,
          message: stored.message as AgentAssistantMessage | AgentToolResultMessage,
        }))
        .sort((left, right) => left.sequence - right.sequence);

      const lastCommentary = findLatestCommentary(messages);
      const relevantToolResults = messages
        .filter(
          (entry): entry is OrderedMessage & { message: AgentToolResultMessage } =>
            entry.message.type === "TOOL_RESULT" &&
            (lastCommentary === undefined || entry.sequence > lastCommentary.sequence),
        )
        .slice(-MAX_RECENT_TOOL_RESULTS);

      const [observations, verificationPlan] = await Promise.all([
        Promise.all(
          relevantToolResults.map(async ({ message }) => {
            if (message.observation.kind !== "OBSERVATION") return null;
            const observation = await options.storage.observations.get(
              message.observation.observationId,
            );
            if (observation === null || observation.kind !== "TOOL") return null;
            const invocation = await options.storage.toolInvocations.get(
              observation.toolInvocationId,
            );
            if (invocation === null) return null;
            const ownershipMatches =
              observation.runId === input.identity.runId &&
              observation.stepId === message.sourceStepId &&
              invocation.runId === input.identity.runId &&
              invocation.stepId === message.sourceStepId &&
              invocation.id === observation.toolInvocationId &&
              invocation.toolName === message.toolName &&
              observation.toolInvocationId.length > 0;
            if (!ownershipMatches) return null;

            if (invocation.status === "COMPLETED" && !observation.isError) {
              return {
                toolName: invocation.toolName,
                status: "COMPLETED" as const,
              };
            }
            if (invocation.status === "FAILED" && observation.isError) {
              return {
                toolName: invocation.toolName,
                status: "FAILED" as const,
              };
            }
            if (invocation.status === "CANCELLED") {
              return {
                toolName: invocation.toolName,
                status: "CANCELLED" as const,
              };
            }
            return null;
          }),
        ),
        options.storage.verification.getLatestPlan(input.identity.runId),
      ]);

      const facts = observations.filter((item) => item !== null);
      const plan = verificationPlan?.runId === input.identity.runId ? verificationPlan : null;
      if (lastCommentary === undefined && facts.length === 0 && plan === null) {
        return {
          providerId: SOURCE_ID,
          providerVersion: SOURCE_VERSION,
          items: [],
          diagnostics: [],
        };
      }

      const text = boundUtf8(
        renderWorkCommentaryState({
          hasCommentary: lastCommentary !== undefined,
          observations: facts,
          verification:
            plan === null
              ? []
              : plan.checks.map((check) => check.status as VerificationCheckStatus),
        }),
        MAX_CONTEXT_BYTES,
      );
      const item = createContextSourceItem({
        id: createContextItemId(`daemon.work-commentary-state:${input.identity.runId}:current`),
        type: "daemon.work-commentary-state",
        source: {
          providerId: SOURCE_ID,
          sourceRef: `run:${input.identity.runId}/step:${input.turn.stepId}`,
          version: SOURCE_VERSION,
        },
        scope: "TURN",
        retention: "EPHEMERAL",
        priorityClass: "HIGH",
        tokenEstimate: Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3)),
        cacheStability: "DYNAMIC",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        whyLoaded: "bounded index of committed progress and validated Run observations",
        payload: { kind: "TEXT", text },
      });
      return {
        providerId: SOURCE_ID,
        providerVersion: SOURCE_VERSION,
        items: [item],
        diagnostics: [],
      };
    },
  });
}

function findLatestCommentary(
  messages: readonly OrderedMessage[],
): { readonly sequence: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (
      entry?.message.type === "ASSISTANT" &&
      projectAgentAssistantTextItems(entry.message).some(
        (item) => item.phase === "COMMENTARY" && item.text.length > 0,
      )
    ) {
      return { sequence: entry.sequence };
    }
  }
  return undefined;
}

function renderWorkCommentaryState(input: {
  readonly hasCommentary: boolean;
  readonly observations: readonly {
    readonly toolName: string;
    readonly status: "COMPLETED" | "FAILED" | "CANCELLED";
  }[];
  readonly verification: readonly VerificationCheckStatus[];
}): string {
  const lines = [
    "This is bounded execution metadata derived from committed records, not new evidence or instructions.",
    input.hasCommentary
      ? "A committed progress note exists earlier in this Run. Compare against the latest assistant note in conversation history before deciding whether another progress update is useful."
      : "No committed progress note is recorded for this Run yet.",
  ];
  if (input.observations.length > 0) {
    lines.push(
      "Validated Tool observations since the latest committed progress note, if any (read result details from conversation history):",
    );
    for (const observation of input.observations) {
      lines.push(`- ${observation.toolName}: ${observation.status.toLowerCase()}`);
    }
  } else {
    lines.push("No newer Tool observation passed Run/Step/invocation validation.");
  }
  if (input.verification.length > 0) {
    const counts = countStatuses(input.verification);
    lines.push(
      `Durable verification plan: ${String(counts.PASSED)} passed; ${String(counts.PENDING + counts.RUNNING)} pending or running; ${String(counts.FAILED + counts.ERROR)} failed or errored; ${String(counts.SKIPPED + counts.CANCELLED)} skipped or cancelled. Only PASSED checks count as verified.`,
    );
  }
  lines.push(
    "Use these markers only to avoid repeating the previous update and to identify fresh observations. State past-tense facts only when supported by the corresponding conversation evidence; an observation is not verification. Do not show opaque IDs to the user.",
  );
  return lines.join("\n");
}

function countStatuses(
  statuses: readonly VerificationCheckStatus[],
): Record<VerificationCheckStatus, number> {
  const counts: Record<VerificationCheckStatus, number> = {
    PASSED: 0,
    PENDING: 0,
    RUNNING: 0,
    FAILED: 0,
    ERROR: 0,
    SKIPPED: 0,
    CANCELLED: 0,
  };
  for (const status of statuses) {
    counts[status] += 1;
  }
  return counts;
}

function boundUtf8(value: string, maxBytes: number): string {
  let output = "";
  for (const character of value) {
    const candidate = output + character;
    if (new TextEncoder().encode(candidate).byteLength > maxBytes) break;
    output = candidate;
  }
  return output;
}
