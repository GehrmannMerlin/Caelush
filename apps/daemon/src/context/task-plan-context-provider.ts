import {
  createContextItemId,
  createContextSourceId,
  createContextSourceItem,
  type ContextSourceInput,
  type ContextSourceProvider,
} from "@caelush/agent";
import {
  boundPlanBlock,
  deriveTaskPlanSnapshot,
  renderTaskPlanBlock,
} from "@caelush/coding-agent";

const SOURCE_ID = createContextSourceId("daemon.task-plan");
const SOURCE_VERSION = "task-plan-v2";

/**
 * The rendered-plan budget, separate from the *input* budget the Tool enforces.
 *
 * The Tool accepts up to 32 KiB of plan; the Context carries a summary. Two limits, two purposes: the
 * accepted record is complete because it is the durable fact, and the projection is bounded because it
 * is repeated in every request. Pinning 32 KiB into every turn would make a long plan a permanent tax
 * on the whole Run.
 */
const MAX_BLOCK_BYTES = 8 * 1024;

/**
 * Publish the Run's current plan and working record as context.
 *
 * The plan is not a second state store: it is re-derived from the accepted `update_plan` call and
 * result of this Run, so what the model reads here cannot disagree with what it recorded. A Run with
 * no accepted plan contributes nothing at all — there is no "empty plan" section to imply that a plan
 * is required.
 *
 * It is `OPTIONAL` and cheap: a simple task that never calls the tool costs nothing, and a long task
 * gets its milestones, unresolved failures and next action back after a compaction replaced the
 * messages that carried them.
 */
export function createTaskPlanContextProvider(): ContextSourceProvider {
  return Object.freeze({
    id: SOURCE_ID,
    async collect(input: ContextSourceInput) {
      const messages = input.conversation.turns
        .flatMap((turn) => turn.messages)
        .filter((stored) => stored.message.runId === input.identity.runId)
        .map((stored) => ({ message: stored.message, sequence: stored.sequence }))
        .sort((left, right) => left.sequence - right.sequence);

      const snapshot = deriveTaskPlanSnapshot({
        runId: String(input.identity.runId),
        messages,
      });
      if (snapshot === undefined) {
        return {
          providerId: SOURCE_ID,
          providerVersion: SOURCE_VERSION,
          items: [],
          diagnostics: [],
        };
      }

      const text = boundPlanBlock(renderTaskPlanBlock(snapshot), MAX_BLOCK_BYTES);
      return {
        providerId: SOURCE_ID,
        providerVersion: SOURCE_VERSION,
        items: [
          createContextSourceItem({
            id: createContextItemId("daemon.task-plan:current"),
            type: "coding.runtime_fact",
            source: {
              providerId: SOURCE_ID,
              sourceRef: "daemon:task-plan",
              version: SOURCE_VERSION,
            },
            scope: "RUN",
            retention: "EPHEMERAL",
            priorityClass: "HIGH",
            // An honest estimate derived from the bounded text, not a constant that misreports a
            // 8 KiB block as 200 tokens.
            tokenEstimate: estimateTokens(text),
            cacheStability: "DYNAMIC",
            freshness: "CURRENT",
            sensitivity: "INTERNAL",
            whyLoaded: `accepted update_plan snapshot v${String(snapshot.planVersion)}`,
            payload: { kind: "TEXT", text },
          }),
        ],
        diagnostics: [],
      };
    },
  });
}

/**
 * A conservative token estimate for a block that may be largely non-ASCII.
 *
 * Four UTF-8 bytes per token is the usual English rule of thumb and badly wrong for CJK, where a
 * single character can be three bytes and one token. Counting bytes and dividing by three keeps the
 * estimate from understating the budget it is used to guard.
 */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}
