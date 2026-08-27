import type { AgentEvent, EventDurability } from "@caelush/protocol";

type DurableEvent = Extract<EventDurability, { kind: "DURABLE" }>;

type WithDurability<TEvent, TDurability> = TEvent extends { type: string }
  ? Omit<TEvent, "durability"> & { durability: TDurability }
  : never;

export type DurableEventDraft = WithDurability<AgentEvent, Omit<DurableEvent, "sequence">>;

export type DurableAgentEvent = WithDurability<AgentEvent, DurableEvent>;
