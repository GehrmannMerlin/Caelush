import type {
  AgentEvent,
  DurableRunEvent,
  RunId,
  TransientRunEvent,
} from "@caelush/protocol";
import type { RunEventNotifierPort } from "@caelush/agent";

type Listener = (event: AgentEvent) => void;

/** Test-only post-commit observer; it deliberately has no Storage write capability. */
export class EventBus implements RunEventNotifierPort {
  private readonly listeners = new Map<RunId, Set<Listener>>();

  constructor(_eventReader?: unknown) {}

  subscribe(runId: RunId, listener: Listener): () => void {
    let listeners = this.listeners.get(runId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(runId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(runId);
    };
  }

  notifyCommitted(events: readonly DurableRunEvent[]): void {
    for (const event of events) this.notify(event);
  }

  emitTransient(event: TransientRunEvent): void {
    this.notify(event);
  }

  private notify(event: AgentEvent): void {
    for (const listener of [...(this.listeners.get(event.runId) ?? [])]) listener(event);
  }
}
