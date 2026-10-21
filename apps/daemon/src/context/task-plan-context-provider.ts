import {
  createUtf8HeuristicTokenEstimator,
  createContextItemId,
  createContextSourceId,
  createContextSourceItem,
  type ContextSourceInput,
  type ContextSourceProvider,
} from "@caelush/agent";
import type { ContextTokenEstimatorPort } from "@caelush/agent";
import {
  deriveTaskPlanSnapshot,
  renderBoundedTaskPlanSections,
  TASK_PLAN_BLOCK_BUDGETS,
} from "@caelush/coding-agent";
import type { TaskPlanEvidenceResolverPort } from "./task-plan-evidence-adapter.js";

const SOURCE_ID = createContextSourceId("daemon.task-plan");
/**
 * The projection version, and only that.
 *
 * `v3` marks the render that prints recorded references, reportedStatus and the resolved
 * independentEvidence separately, counts evidence per step, and gives evidence its own section above
 * the discretionary tail. The plan input protocol and the message schema did not change: a v3 item
 * describes the same accepted plan as v2 did, in a shape that cannot contradict itself. A Context
 * persisted by v2 is still a valid persisted Context, so recovery keeps its existing rule and does
 * not replay a non-replayable Hook to obtain a v3 rendering.
 *
 * `v4` splits that one 8 KiB item into three bounded items — `current`, `evidence`, `notice` — with
 * the same content and the same total budget. A Prompt Surface Section is rewritten as a whole, so a
 * single block whose last line counted accepted Tool results rewrote 8 KiB on every Step; the count
 * now lives in the 512-byte notice and the stable body does not move.
 */
const SOURCE_VERSION = "task-plan-v4";

/**
 * The rendered-plan budget, separate from the *input* budget the Tool enforces.
 *
 * The Tool accepts up to 32 KiB of plan; the Context carries a summary. Two limits, two purposes: the
 * accepted record is complete because it is the durable fact, and the projection is bounded because it
 * is repeated in every request. Pinning 32 KiB into every turn would make a long plan a permanent tax
 * on the whole Run.
 */
const MAX_BLOCK_BYTES =
  TASK_PLAN_BLOCK_BUDGETS.current + TASK_PLAN_BLOCK_BUDGETS.evidence + TASK_PLAN_BLOCK_BUDGETS.notice;

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
export function createTaskPlanContextProvider(
  options: {
    readonly tokenEstimator?: ContextTokenEstimatorPort;
    readonly evidenceResolver?: TaskPlanEvidenceResolverPort;
  } = {},
): ContextSourceProvider {
  const tokenEstimator = options.tokenEstimator ?? createUtf8HeuristicTokenEstimator();
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

      const refs = snapshot.steps.flatMap((step) => step.evidenceRefs ?? []);
      const [evidence, availableEvidenceRefs] = await Promise.all([
        options.evidenceResolver === undefined || refs.length === 0
          ? Promise.resolve([])
          : options.evidenceResolver.resolve({
              identity: input.identity,
              planRevision: snapshot.revision,
              refs,
              conversation: input.conversation,
            }),
        options.evidenceResolver === undefined
          ? Promise.resolve([])
          : options.evidenceResolver.available({
              identity: input.identity,
              conversation: input.conversation,
            }),
      ]);
      const rendered = renderBoundedTaskPlanSections(snapshot, {
        maxBytes: MAX_BLOCK_BYTES,
        evidence,
        availableEvidenceRefs,
      });
      const item = (
        part: "current" | "evidence" | "notice",
        text: string,
        priorityClass: "HIGH" | "NORMAL" | "LOW",
        whyLoaded: string,
      ) =>
        createContextSourceItem({
          id: createContextItemId(`daemon.task-plan:${part}`),
          type: "coding.runtime_fact",
          source: {
            providerId: SOURCE_ID,
            sourceRef: `daemon:task-plan/${part}`,
            version: SOURCE_VERSION,
          },
          scope: "RUN",
          retention: "EPHEMERAL",
          priorityClass,
          tokenEstimate: tokenEstimator.estimateText(text, input.model),
          cacheStability: "DYNAMIC",
          freshness: "CURRENT",
          sensitivity: "INTERNAL",
          whyLoaded,
          payload: { kind: "TEXT", text },
        });
      const items = [
        item("current", rendered.current, "HIGH", `accepted update_plan snapshot v${String(snapshot.planVersion)}`),
        item("evidence", rendered.evidence, "NORMAL", "independent evidence for the references the plan cited"),
        item("notice", rendered.notice, "LOW", "accepted plan bookkeeping; changes every Step"),
      ].filter((entry) => (entry.payload as { text?: string }).text !== "");
      return {
        providerId: SOURCE_ID,
        providerVersion: SOURCE_VERSION,
        items,
        diagnostics: [],
      };
    },
  });
}
