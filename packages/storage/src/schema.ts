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

export const runCancellationRequests = sqliteTable(
  "run_cancellation_requests",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => agentRuns.id),
    cause: text("cause").notNull(),
    requestedAtMs: integer("requested_at_ms").notNull(),
  },
  (table) => [index("run_cancellation_requests_requested_at_idx").on(table.requestedAtMs)],
);

export const runBudgetEntries = sqliteTable(
  "run_budget_entries",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    kind: text("kind").notNull(),
    ownerId: text("owner_id").notNull(),
    state: text("state").notNull(),
    reservedToolCalls: integer("reserved_tool_calls").notNull(),
    reservedInputTokens: integer("reserved_input_tokens").notNull(),
    reservedOutputTokens: integer("reserved_output_tokens").notNull(),
    actualInputTokens: integer("actual_input_tokens"),
    actualOutputTokens: integer("actual_output_tokens"),
    reservedCostMicros: integer("reserved_cost_micros").notNull(),
    actualCostMicros: integer("actual_cost_micros"),
    modelProvider: text("model_provider"),
    modelId: text("model_id"),
    pricingSnapshotId: text("pricing_snapshot_id"),
    inputRateMicrosPerMillion: integer("input_rate_micros_per_million"),
    outputRateMicrosPerMillion: integer("output_rate_micros_per_million"),
    createdAtMs: integer("created_at_ms").notNull(),
    startedAtMs: integer("started_at_ms"),
    settledAtMs: integer("settled_at_ms"),
  },
  (table) => [
    uniqueIndex("run_budget_entries_owner_unique").on(table.runId, table.kind, table.ownerId),
    index("run_budget_entries_run_id_idx").on(table.runId),
    index("run_budget_entries_state_idx").on(table.state),
  ],
);

export const runResourceStates = sqliteTable(
  "run_resource_states",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => agentRuns.id),
    policyVersion: text("policy_version").notNull(),
    mode: text("mode").notNull(),
    leaseEpoch: integer("lease_epoch").notNull(),
    leaseStartAgentTurns: integer("lease_start_agent_turns").notNull(),
    leaseStartToolCalls: integer("lease_start_tool_calls").notNull(),
    agentTurnsConsumed: integer("agent_turns_consumed").notNull(),
    toolOperationsConsumed: integer("tool_operations_consumed").notNull(),
    lastProgressAtMs: integer("last_progress_at_ms"),
    consecutiveNoProgressTurns: integer("consecutive_no_progress_turns").notNull(),
    replanCount: integer("replan_count").notNull(),
    resourceGuardState: text("resource_guard_state").notNull(),
    revision: integer("revision").notNull(),
    recentFingerprintsJson: text("recent_fingerprints_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [index("run_resource_states_guard_state_idx").on(table.resourceGuardState)],
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

export const toolInvocations = sqliteTable(
  "tool_invocations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    stepId: text("step_id")
      .notNull()
      .references(() => agentSteps.id),
    externalCallId: text("external_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull(),
    riskLevel: text("risk_level").notNull(),
    revision: integer("revision").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    startedAtMs: integer("started_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    uniqueIndex("tool_invocations_run_step_external_call_unique").on(
      table.runId,
      table.stepId,
      table.externalCallId,
    ),
    index("tool_invocations_run_id_idx").on(table.runId),
    index("tool_invocations_step_id_idx").on(table.stepId),
    index("tool_invocations_status_idx").on(table.status),
  ],
);

export const agentObservations = sqliteTable(
  "agent_observations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    stepId: text("step_id")
      .notNull()
      .references(() => agentSteps.id),
    kind: text("kind").notNull(),
    toolInvocationId: text("tool_invocation_id").references(() => toolInvocations.id),
    protocolVersion: integer("protocol_version").notNull(),
    isError: integer("is_error").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    uniqueIndex("agent_observations_tool_invocation_unique").on(table.toolInvocationId),
    index("agent_observations_run_id_idx").on(table.runId),
    index("agent_observations_step_id_idx").on(table.stepId),
  ],
);

export const contextCheckpoints = sqliteTable(
  "context_checkpoints",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    previousCheckpointId: text("previous_checkpoint_id"),
    sourceSequenceFrom: integer("source_sequence_from").notNull(),
    sourceSequenceTo: integer("source_sequence_to").notNull(),
    tokensBefore: integer("tokens_before").notNull(),
    tokensAfter: integer("tokens_after").notNull(),
    summaryVersion: integer("summary_version").notNull(),
    modelRefJson: text("model_ref_json"),
    createdAtMs: integer("created_at_ms").notNull(),
    dataJson: text("data_json").notNull(),
    readFileRefsJson: text("read_file_refs_json").notNull(),
    changedFileRefsJson: text("changed_file_refs_json").notNull(),
  },
  (table) => [
    index("context_checkpoints_run_sequence_idx").on(table.runId, table.sourceSequenceTo),
  ],
);

export const contextArtifacts = sqliteTable(
  "context_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    kind: text("kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    contentHash: text("content_hash").notNull(),
    byteLength: integer("byte_length").notNull(),
    mimeType: text("mime_type").notNull(),
    sensitivity: text("sensitivity").notNull(),
    createdSequence: integer("created_sequence").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    content: text("content").notNull(),
  },
  (table) => [index("context_artifacts_run_id_idx").on(table.runId)],
);

export const memoryRecords = sqliteTable(
  "memory_records",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    projectId: text("project_id"),
    topic: text("topic").notNull(),
    fact: text("fact").notNull(),
    status: text("status").notNull(),
    confidence: integer("confidence").notNull(),
    evidenceRefsJson: text("evidence_refs_json").notNull(),
    sourceRunIdsJson: text("source_run_ids_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    lastConfirmedAtMs: integer("last_confirmed_at_ms").notNull(),
    supersedes: text("supersedes"),
    supersededBy: text("superseded_by"),
    sensitivity: text("sensitivity").notNull(),
    schemaVersion: integer("schema_version").notNull(),
  },
  (table) => [index("memory_records_scope_project_idx").on(table.scope, table.projectId)],
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    toolInvocationId: text("tool_invocation_id")
      .notNull()
      .unique()
      .references(() => toolInvocations.id),
    approvalKey: text("approval_key").notNull(),
    status: text("status").notNull(),
    scope: text("scope").notNull(),
    grantedScope: text("granted_scope"),
    riskLevel: text("risk_level").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms"),
    resolvedAtMs: integer("resolved_at_ms"),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    index("approval_requests_run_id_idx").on(table.runId),
    index("approval_requests_status_idx").on(table.status),
    index("approval_requests_run_status_idx").on(table.runId, table.status),
    index("approval_requests_run_key_idx").on(table.runId, table.approvalKey),
  ],
);

export const verificationPlans = sqliteTable(
  "verification_plans",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    sourceStepId: text("source_step_id")
      .notNull()
      .references(() => agentSteps.id),
    plannerVersion: text("planner_version").notNull(),
    planHash: text("plan_hash").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    uniqueIndex("verification_plans_run_source_unique").on(table.runId, table.sourceStepId),
    index("verification_plans_run_id_idx").on(table.runId),
  ],
);

export const verificationChecks = sqliteTable(
  "verification_checks",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => verificationPlans.id),
    ordinal: integer("ordinal").notNull(),
    stage: text("stage").notNull(),
    requirement: text("requirement").notNull(),
    status: text("status").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    startedAtMs: integer("started_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    skipReason: text("skip_reason"),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    uniqueIndex("verification_checks_plan_ordinal_unique").on(table.planId, table.ordinal),
    index("verification_checks_plan_id_idx").on(table.planId),
    index("verification_checks_status_idx").on(table.status),
  ],
);

export const verificationEvidence = sqliteTable(
  "verification_evidence",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => verificationPlans.id),
    checkId: text("check_id")
      .notNull()
      .references(() => verificationChecks.id),
    kind: text("kind").notNull(),
    capturedAtMs: integer("captured_at_ms").notNull(),
    dataJson: text("data_json").notNull(),
  },
  (table) => [
    index("verification_evidence_plan_id_idx").on(table.planId),
    index("verification_evidence_check_id_idx").on(table.checkId),
  ],
);

export const storageSchema = {
  agentSessions,
  agentRuns,
  runCancellationRequests,
  runBudgetEntries,
  runResourceStates,
  agentSteps,
  agentStateSnapshots,
  agentMessages,
  agentRunContinuations,
  eventSequences,
  agentEvents,
  toolInvocations,
  agentObservations,
  approvalRequests,
  verificationPlans,
  verificationChecks,
  verificationEvidence,
};
