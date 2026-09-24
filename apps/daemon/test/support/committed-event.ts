import type { DurableRunEventDraft, RunEventNotifierPort } from "@caelush/agent";
import type { AgentRun } from "@caelush/protocol";
import type { CaelushStorage } from "@caelush/storage";

/**
 * Test-only committed-event fixture.
 *
 * It uses the public Run execution authority, so SSE tests exercise the same
 * transaction → committed event → notifier sequence as production without
 * granting EventBus a durable write capability.
 */
export async function commitDurableTestEvent(
  storage: CaelushStorage,
  notifier: RunEventNotifierPort,
  draft: DurableRunEventDraft,
): Promise<void> {
  const run = await storage.runs.get(draft.runId);
  if (run === null) throw new Error(`Run ${draft.runId} is unavailable for the test event.`);
  const result = await storage.execution.commit({
    run: run as AgentRun,
    expectedStateRevision: null,
    expectedContinuationRevision: null,
    stepWrites: [],
    messagesToAppend: [],
    events: [draft],
  });
  if (result.events.length !== 1) throw new Error("Test event commit did not return one event.");
  notifier.notifyCommitted(result.events);
}
