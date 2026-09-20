/**
 * The legacy durable Tool event factory.
 *
 * ```text
 * Phase 4C moved the canonical factories to @caelush/agent
 * this module re-exports them
 * ```
 *
 * The layer that performs a durable commit is the layer that must state what it is committing, and
 * that layer is now the canonical durable shell. The event *shapes* are unchanged: same types, same
 * payloads, same `schemaVersion`, same durability marker, same optional presentation fields. Nothing
 * about the durable event stream moves.
 */
export {
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createToolCompletedEvent,
  createToolFailedEvent,
  createToolOutputEvent,
  createToolRequestedEvent,
  createToolStartedEvent,
  MAX_TOOL_EVENT_PRESENTATION_BYTES,
} from "@caelush/agent";
