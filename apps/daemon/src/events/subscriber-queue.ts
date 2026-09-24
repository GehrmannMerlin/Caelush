import type { RunEvent } from "@caelush/protocol";

export interface SubscriberQueuePolicy {
  readonly maxPendingItems: number;
  readonly maxPendingBytes: number;
  readonly durableOverflow: "CLOSE_SUBSCRIPTION";
  readonly orderedTransientOverflow: "CLOSE_SUBSCRIPTION";
  readonly coalescibleTransientOverflow: "REPLACE_BY_STREAM_KEY";
}

export const DEFAULT_SUBSCRIBER_QUEUE_POLICY: SubscriberQueuePolicy = Object.freeze({
  maxPendingItems: 256,
  maxPendingBytes: 1_048_576,
  durableOverflow: "CLOSE_SUBSCRIPTION",
  orderedTransientOverflow: "CLOSE_SUBSCRIPTION",
  coalescibleTransientOverflow: "REPLACE_BY_STREAM_KEY",
});

export type SubscriberQueueCloseReason =
  "UNSUBSCRIBED" | "ABORTED" | "SLOW_CONSUMER" | "HUB_DISPOSED";

function isCoalescible(event: RunEvent): boolean {
  return (
    event.durability.kind === "EPHEMERAL" &&
    "deliveryClass" in event.durability &&
    event.durability.deliveryClass === "COALESCIBLE"
  );
}

function coalescingKey(event: RunEvent): string | undefined {
  if (!isCoalescible(event)) return undefined;
  if (!("streamKey" in event.durability)) return undefined;
  return `${event.runId}\u0000${event.durability.streamKey}`;
}

export function encodedRunEventBytes(event: RunEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export class BoundedSubscriberQueue {
  private readonly values: Array<{ readonly event: RunEvent; readonly bytes: number }> = [];
  private readonly waiters: Array<(event: RunEvent | undefined) => void> = [];
  private pendingBytesValue = 0;
  private closedValue = false;
  private closeReasonValue: SubscriberQueueCloseReason | undefined;

  constructor(
    private readonly policy: SubscriberQueuePolicy,
    private readonly onOverflow: () => void,
  ) {}

  get closed(): boolean {
    return this.closedValue;
  }

  get closeReason(): SubscriberQueueCloseReason | undefined {
    return this.closeReasonValue;
  }

  get pendingItems(): number {
    return this.values.length;
  }

  get pendingBytes(): number {
    return this.pendingBytesValue;
  }

  enqueue(event: RunEvent): boolean {
    if (this.closedValue) return false;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(event);
      return true;
    }
    const bytes = encodedRunEventBytes(event);
    const key = coalescingKey(event);
    if (key !== undefined) {
      const index = this.values.findIndex((item) => coalescingKey(item.event) === key);
      if (index >= 0) {
        const previous = this.values[index];
        if (previous === undefined) return false;
        const nextBytes = this.pendingBytesValue - previous.bytes + bytes;
        if (bytes > this.policy.maxPendingBytes || nextBytes > this.policy.maxPendingBytes) {
          this.onOverflow();
          return false;
        }
        this.values[index] = { event, bytes };
        this.pendingBytesValue = nextBytes;
        return true;
      }
    }

    if (
      this.values.length + 1 > this.policy.maxPendingItems ||
      this.pendingBytesValue + bytes > this.policy.maxPendingBytes
    ) {
      this.onOverflow();
      return false;
    }

    this.values.push({ event, bytes });
    this.pendingBytesValue += bytes;
    return true;
  }

  next(): Promise<RunEvent | undefined> {
    const item = this.values.shift();
    if (item !== undefined) {
      this.pendingBytesValue -= item.bytes;
      return Promise.resolve(item.event);
    }
    if (this.closedValue) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  drain(): RunEvent[] {
    const drained = this.values.map((item) => item.event);
    this.values.length = 0;
    this.pendingBytesValue = 0;
    return drained;
  }

  close(reason: SubscriberQueueCloseReason): void {
    if (this.closedValue) return;
    this.closedValue = true;
    this.closeReasonValue = reason;
    this.values.length = 0;
    this.pendingBytesValue = 0;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }
}
