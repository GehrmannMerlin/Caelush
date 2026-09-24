import type { DurableRunEvent, DurableRunEventDraft } from "@caelush/agent";

/** @deprecated Use the Agent-owned DurableRunEventDraft. */
export type DurableEventDraft = DurableRunEventDraft;

/** @deprecated Use the Protocol DurableRunEvent type. */
export type DurableAgentEvent = DurableRunEvent;
