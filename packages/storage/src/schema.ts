import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  protocolVersion: integer("protocol_version").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  dataJson: text("data_json").notNull(),
});

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id),
    protocolVersion: integer("protocol_version").notNull(),
    status: text("status").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    startedAtMs: integer("started_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    index("agent_runs_session_id_idx").on(table.sessionId),
    index("agent_runs_session_created_at_idx").on(table.sessionId, table.createdAtMs),
    index("agent_runs_status_idx").on(table.status),
  ],
);

export const agentSteps = sqliteTable(
  "agent_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    dataJson: text("data_json").notNull(),
  },
  (table) => [uniqueIndex("agent_steps_run_sequence_unique").on(table.runId, table.sequence)],
);

export const agentStateSnapshots = sqliteTable("agent_state_snapshots", {
  runId: text("run_id")
    .primaryKey()
    .references(() => agentRuns.id),
  revision: integer("revision").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  dataJson: text("data_json").notNull(),
});

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    sequence: integer("sequence").notNull(),
    role: text("role").notNull(),
    sourceStepId: text("source_step_id").references(() => agentSteps.id),
    protocolVersion: integer("protocol_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    uniqueIndex("agent_messages_run_sequence_unique").on(table.runId, table.sequence),
    index("agent_messages_run_sequence_idx").on(table.runId, table.sequence),
  ],
);

export const agentRunContinuations = sqliteTable("agent_run_continuations", {
  runId: text("run_id")
    .primaryKey()
    .references(() => agentRuns.id),
  kind: text("kind").notNull(),
  sourceStepId: text("source_step_id")
    .notNull()
    .references(() => agentSteps.id),
  revision: integer("revision").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  dataJson: text("data_json").notNull(),
});

export const eventSequences = sqliteTable("event_sequences", {
  runId: text("run_id")
    .primaryKey()
    .references(() => agentRuns.id),
  lastSequence: integer("last_sequence").notNull(),
});

export const agentEvents = sqliteTable(
  "agent_events",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id),
    stepId: text("step_id").references(() => agentSteps.id),
    aggregateSequence: integer("aggregate_sequence").notNull(),
    eventType: text("event_type").notNull(),
    eventSchemaVersion: integer("event_schema_version").notNull(),
    visibility: text("visibility").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    uniqueIndex("agent_events_run_sequence_unique").on(table.runId, table.aggregateSequence),
    index("agent_events_run_sequence_idx").on(table.runId, table.aggregateSequence),
  ],
);

export const storageSchema = {
  agentSessions,
  agentRuns,
  agentSteps,
  agentStateSnapshots,
  agentMessages,
  agentRunContinuations,
  eventSequences,
  agentEvents,
};
