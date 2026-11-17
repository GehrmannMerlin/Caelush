import {
  WorkflowResourceBindingDraftV1Schema,
  RunWorkflowExecutionProfileV1Schema,
  WorkflowResourceBindingV1Schema,
  type RunId,
  type WorkflowResourceBindingDraftV1,
  type RunWorkflowExecutionProfileV1,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";
import { randomUUID } from "node:crypto";
import {
  MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS,
  ToolResourceBindingRejectedError,
} from "@caelush/agent";
import type { CaelushDatabase } from "./database.js";
import { decodeProtocol, encodeProtocol } from "./codec.js";
import { StorageDecodeError } from "./errors.js";

const MAX_RESOURCE_BINDINGS_PER_COMMIT = 100;

export function encodeWorkflowExecutionProfile(profile: RunWorkflowExecutionProfileV1): string {
  return encodeProtocol(RunWorkflowExecutionProfileV1Schema, profile, {
    entityType: "RunWorkflowExecutionProfileV1",
    entityId: profile.runId,
    table: "run_workflow_profiles",
  });
}

export function decodeWorkflowExecutionProfile(
  dataJson: string,
  expectedRunId: RunId,
): RunWorkflowExecutionProfileV1 {
  const profile = decodeProtocol(RunWorkflowExecutionProfileV1Schema, dataJson, {
    entityType: "RunWorkflowExecutionProfileV1",
    entityId: expectedRunId,
    table: "run_workflow_profiles",
  });
  if (profile.runId !== expectedRunId) {
    throw new StorageDecodeError(
      "RunWorkflowExecutionProfileV1",
      expectedRunId,
      "run_workflow_profiles",
    );
  }
  return profile;
}

export function encodePreparedResourceRecord(record: WorkflowResourceBindingV1): string {
  return encodeProtocol(WorkflowResourceBindingV1Schema, record, {
    entityType: "WorkflowResourceBindingV1",
    entityId: record.bindingId,
    table: "run_prepared_resources",
  });
}

export function decodePreparedResourceRecord(
  dataJson: string,
  expected: { readonly bindingId: string; readonly runId: RunId },
): WorkflowResourceBindingV1 {
  const record = decodeProtocol(WorkflowResourceBindingV1Schema, dataJson, {
    entityType: "WorkflowResourceBindingV1",
    entityId: expected.bindingId,
    table: "run_prepared_resources",
  });
  if (record.bindingId !== expected.bindingId || record.runId !== expected.runId) {
    throw new StorageDecodeError(
      "WorkflowResourceBindingV1",
      expected.bindingId,
      "run_prepared_resources",
    );
  }
  return record;
}

/**
 * Persist generic resource identities inside the authoritative Tool transaction.
 *
 * The storage boundary rechecks the aggregate budget under `BEGIN IMMEDIATE`; the caller's
 * preflight cannot reserve capacity for a concurrent Tool settlement.
 */
export function writePreparedResourceBindingsInTransaction(
  database: CaelushDatabase,
  input: {
    readonly runId: RunId;
    readonly invocationId: string;
    readonly bindings: readonly WorkflowResourceBindingDraftV1[] | undefined;
  },
): void {
  const { bindings } = input;
  if (bindings === undefined) return;
  if (bindings.length === 0 || bindings.length > MAX_RESOURCE_BINDINGS_PER_COMMIT) {
    throw new ToolResourceBindingRejectedError();
  }

  const candidates: WorkflowResourceBindingDraftV1[] = [];
  const identities = new Set<string>();
  for (const raw of bindings) {
    const parsed = WorkflowResourceBindingDraftV1Schema.safeParse(raw);
    if (!parsed.success) throw new ToolResourceBindingRejectedError({ cause: parsed.error });
    const binding = parsed.data;
    if (
      binding.runId !== input.runId ||
      binding.sourceToolInvocationId !== input.invocationId ||
      binding.tokenEstimate !== Math.ceil(binding.utf8Bytes / 3) ||
      binding.tokenEstimate > MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS
    ) {
      throw new ToolResourceBindingRejectedError();
    }
    const identity = `${binding.resourceKind}\u0000${binding.resourceId}\u0000${binding.resourceRevision}`;
    if (identities.has(identity)) throw new ToolResourceBindingRejectedError();
    identities.add(identity);
    candidates.push(binding);
  }

  const client = database.client;
  const rows = client
    .prepare(
      "SELECT binding_id, run_id, data_json FROM run_prepared_resources WHERE run_id = ? " +
        "ORDER BY activation_ordinal ASC",
    )
    .all(input.runId) as Array<{ binding_id: string; run_id: string; data_json: string }>;
  const current = rows.map((row) => {
    const record = decodePreparedResourceRecord(row.data_json, {
      bindingId: row.binding_id,
      runId: input.runId,
    });
    if (record.runId !== row.run_id) {
      throw new StorageDecodeError(
        "WorkflowResourceBindingV1",
        row.binding_id,
        "run_prepared_resources",
      );
    }
    return record;
  });

  let activeTokens = current.reduce((sum, record) => sum + record.tokenEstimate, 0);
  if (
    !Number.isSafeInteger(activeTokens) ||
    activeTokens > MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS
  ) {
    throw new ToolResourceBindingRejectedError();
  }
  const existingByIdentity = new Map(
    current.map((record) => [
      `${record.resourceKind}\u0000${record.resourceId}\u0000${record.resourceRevision}`,
      record,
    ]),
  );
  let activationOrdinal = current.reduce(
    (maximum, record) => Math.max(maximum, record.activationOrdinal),
    -1,
  );
  const insert = client.prepare(
    "INSERT INTO run_prepared_resources " +
      "(binding_id, run_id, resource_kind, resource_id, resource_revision, artifact_ref, " +
      "source_fingerprint, utf8_bytes, token_estimate, source_tool_invocation_id, " +
      "activation_ordinal, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  for (const candidate of candidates) {
    const identity = `${candidate.resourceKind}\u0000${candidate.resourceId}\u0000${candidate.resourceRevision}`;
    const prior = existingByIdentity.get(identity);
    if (prior !== undefined) {
      if (
        prior.artifactRef !== candidate.artifactRef ||
        prior.sourceFingerprint !== candidate.sourceFingerprint ||
        prior.utf8Bytes !== candidate.utf8Bytes ||
        prior.tokenEstimate !== candidate.tokenEstimate
      ) {
        throw new ToolResourceBindingRejectedError();
      }
      continue;
    }
    activeTokens += candidate.tokenEstimate;
    if (
      !Number.isSafeInteger(activeTokens) ||
      activeTokens > MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS
    ) {
      throw new ToolResourceBindingRejectedError();
    }
    const record = WorkflowResourceBindingV1Schema.parse({
      ...candidate,
      bindingId: randomUUID(),
      activationOrdinal: ++activationOrdinal,
    });
    insert.run(
      record.bindingId,
      record.runId,
      record.resourceKind,
      record.resourceId,
      record.resourceRevision,
      record.artifactRef,
      record.sourceFingerprint,
      record.utf8Bytes,
      record.tokenEstimate,
      record.sourceToolInvocationId ?? null,
      record.activationOrdinal,
      encodePreparedResourceRecord(record),
    );
    existingByIdentity.set(identity, record);
  }
}
