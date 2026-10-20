import {
  createContextItemId,
  createContextSourceId,
  createContextSourceItem,
  type ContextSourceInput,
  type ContextSourceProvider,
} from "@caelush/agent";
import { deriveTaskPlanSnapshot, renderTaskPlanBlock } from "@caelush/coding-agent";

const SOURCE_ID = createContextSourceId("daemon.task-plan");
const SOURCE_VERSION = "task-plan-v1";
const MAX_BLOCK_BYTES = 4 * 1024;

/**
 * Publish the Run's current plan as context.
 *
 * The plan is not a second state store: it is re-derived from the accepted `update_plan` call and
 * result of this Run, so what the model reads here cannot disagree with what it recorded. A Run with
 * no accepted plan contributes nothing at all — there is no "empty plan" section to imply that a plan
 * is required.
 *
 * It is `OPTIONAL` and cheap: a simple task that never calls the tool costs nothing, and a long task
 * gets its step list back after a compaction replaced the messages that carried it.
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

      const block = renderTaskPlanBlock(snapshot);
      const text =
        Buffer.byteLength(block, "utf8") > MAX_BLOCK_BYTES
          ? `${block.slice(0, MAX_BLOCK_BYTES)}\n[plan truncated]`
          : block;
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
            tokenEstimate: 200,
            cacheStability: "DYNAMIC",
            freshness: "CURRENT",
            sensitivity: "INTERNAL",
            whyLoaded: "accepted update_plan snapshot",
            payload: { kind: "TEXT", text },
          }),
        ],
        diagnostics: [],
      };
    },
  });
}
