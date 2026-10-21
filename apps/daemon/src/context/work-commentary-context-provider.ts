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
const SOURCE_VERSION = "work-commentary-state-v3";
const MAX_RECENT_TOOL_RESULTS = 6;
/**
 * The item is a Prompt Surface Section, and a Section is replaced as a whole.
 *
 * A 4 KiB block that listed every validated Tool result rewrote 4 KiB on every Step for a list the
 * model can already read in the conversation. The block is now bounded by what actually changes the
 * next decision — whether a progress note exists, whether something failed, and what the durable
 * verification plan says — so a Step's churn is at most this many bytes.
 */
const MAX_CONTEXT_BYTES = 512;

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

/**
 * Render the progress cue.
 *
 * ```text
 * completed observations   one line, whatever their number   a count is not information
 * a failure or a cancel    named, because it changes the next decision
 * verification counts      only when a durable plan exists
 * ```
 *
 * The block never mentions how many observations arrived: that is the number that changes on every
 * Step, and repeating it here would rewrite the Section for a fact the conversation already shows.
 */
function renderWorkCommentaryState(input: {
  readonly hasCommentary: boolean;
  readonly observations: readonly {
    readonly toolName: string;
    readonly status: "COMPLETED" | "FAILED" | "CANCELLED";
  }[];
  readonly verification: readonly VerificationCheckStatus[];
}): string {
  const unresolved = input.observations.filter((observation) => observation.status !== "COMPLETED");
  const lines = [
    "Bounded execution metadata from committed records; not evidence or instructions.",
    input.hasCommentary
      ? "A committed progress note exists earlier in this Run. Do not repeat it; compare against it before writing another."
      : "No committed progress note is recorded for this Run yet.",
  ];
  if (input.observations.length === 0) {
    lines.push("No newer Tool observation passed Run/Step/invocation validation.");
  } else if (unresolved.length === 0) {
    lines.push(
      "Newer validated observations all completed; read their results in conversation history.",
    );
  } else {
    lines.push(
      "Newer validated observations that did not complete (results stay in conversation history):",
    );
    for (const observation of unresolved) {
      lines.push(`- ${observation.toolName}: ${observation.status.toLowerCase()}`);
    }
  }
  if (input.verification.length > 0) {
    const counts = countStatuses(input.verification);
    lines.push(
      `Durable verification plan: ${String(counts.PASSED)} passed; ${String(counts.PENDING + counts.RUNNING)} pending or running; ${String(counts.FAILED + counts.ERROR)} failed or errored; ${String(counts.SKIPPED + counts.CANCELLED)} skipped or cancelled. Only PASSED checks count as verified.`,
    );
  }
  lines.push(
    "An observation is not verification. Do not show opaque IDs to the user.",
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
