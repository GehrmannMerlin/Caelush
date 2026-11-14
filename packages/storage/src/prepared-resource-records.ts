import {
  RunWorkflowExecutionProfileV1Schema,
  WorkflowResourceBindingV1Schema,
  type RunId,
  type RunWorkflowExecutionProfileV1,
  type WorkflowResourceBindingV1,
} from "@caelush/protocol";
import { decodeProtocol, encodeProtocol } from "./codec.js";
import { StorageDecodeError } from "./errors.js";

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
