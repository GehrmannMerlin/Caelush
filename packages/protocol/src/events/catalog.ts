import type { EventSchemaVersion, EventVisibility, TransientDeliveryClass } from "./base.js";

export interface RunEventTypeDefinition {
  readonly type: string;
  readonly schemaVersion: EventSchemaVersion;
  readonly visibility: EventVisibility;
  readonly delivery:
    | { readonly kind: "DURABLE" }
    | { readonly kind: "TRANSIENT"; readonly class: TransientDeliveryClass };
}

function durable(
  type: string,
  visibility: EventVisibility = "USER_VISIBLE",
): RunEventTypeDefinition {
  const delivery = Object.freeze({ kind: "DURABLE" as const });
  return Object.freeze({
    type,
    schemaVersion: 1,
    visibility,
    delivery,
  });
}

/**
 * The Phase 6A catalog describes the schemas that are registered today. It does not change the
 * current v1 write behavior: output events remain durable until the designated transient phase.
 */
export const RUN_EVENT_TYPE_CATALOG: readonly RunEventTypeDefinition[] = Object.freeze([
  durable("run.started"),
  durable("run.timed_out"),
  durable("run.completed"),
  durable("run.failed"),
  durable("run.cancelled"),
  durable("status.changed"),
  durable("reasoning.summary"),
  durable("plan.updated"),
  durable("tool.requested"),
  durable("tool.started"),
  durable("tool.output"),
  durable("tool.completed"),
  durable("tool.failed"),
  durable("file.read"),
  durable("file.created"),
  durable("file.modified"),
  durable("file.moved"),
  durable("file.deleted"),
  durable("shell.started"),
  durable("shell.output"),
  durable("shell.completed"),
  durable("process.started"),
  durable("process.output"),
  durable("process.stopped"),
  durable("verification.started"),
  durable("verification.completed"),
  durable("verification.check.started"),
  durable("verification.check.completed"),
  durable("verification.planned"),
  durable("verification.repair.started"),
  durable("verification.repair.limit_reached"),
  durable("verification.finalized"),
  durable("approval.requested"),
  durable("approval.resolved"),
  durable("llm.started"),
  durable("llm.completed"),
  durable("llm.failed"),
  durable("retry.scheduled"),
  durable("retry.started"),
  durable("error", "DEBUG"),
  durable("budget.exceeded"),
  durable("resource.guard"),
]);

export const RunEventTypeCatalog = RUN_EVENT_TYPE_CATALOG;

const catalogByKey = new Map(
  RUN_EVENT_TYPE_CATALOG.map((definition) => [
    `${definition.type}\u0000${definition.schemaVersion}`,
    definition,
  ]),
);

export function getRunEventTypeDefinition(
  type: string,
  schemaVersion: number,
): RunEventTypeDefinition | undefined {
  return catalogByKey.get(`${type}\u0000${schemaVersion}`);
}
