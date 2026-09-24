import type { DurableRunEvent, DurableRunEventMeta } from "@caelush/protocol";

type DurableRunEventDraftMeta = Omit<DurableRunEventMeta, "sequence">;

/**
 * A durable Run Event before Storage assigns its per-Run chronology sequence.
 *
 * This is an Agent-owned description of a commit, not a write capability. Storage remains the
 * only authority allowed to attach `durability.sequence` inside its transaction.
 */
export type DurableRunEventDraft<TEvent extends DurableRunEvent = DurableRunEvent> =
  TEvent extends DurableRunEvent
    ? Omit<TEvent, "durability"> & { readonly durability: DurableRunEventDraftMeta }
    : never;
