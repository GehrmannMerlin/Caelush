import type {
  PreparedWorkflowResourceRefV1,
  RunId,
  WorkflowResourceBindingV1,
} from "@caelush/protocol";

export interface ActiveWorkflowResource {
  readonly binding: WorkflowResourceBindingV1;
  readonly rendererVersion: string;
  /** Complete immutable instruction body read from this Run's bound artifact. */
  readonly body: string;
}

export interface ActiveWorkflowResourceReader {
  load(input: {
    readonly runId: RunId;
    readonly signal: AbortSignal;
  }): Promise<readonly ActiveWorkflowResource[]>;
}

export interface WorkflowInstructionFragmentV1 {
  readonly bindingId: string;
  readonly projectionFingerprint: string;
  readonly rendererVersion: string;
  /** Complete, bounded, redacted fragment that the materializer places in model input. */
  readonly text: string;
}

export interface PreparedWorkflowProjection {
  readonly resources: readonly PreparedWorkflowResourceRefV1[];
  readonly fragments: readonly WorkflowInstructionFragmentV1[];
}

export const WORKFLOW_INSTRUCTION_SOURCE_ID = "agent.workflow-instructions" as const;
export const WORKFLOW_INSTRUCTION_PROVIDER_VERSION = "workflow-instruction-v1" as const;
export const MAX_WORKFLOW_INSTRUCTION_BYTES = 64 * 1024;
export const MAX_ACTIVE_WORKFLOW_INSTRUCTION_TOKENS = 16_384;
