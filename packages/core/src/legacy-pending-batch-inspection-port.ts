import type { RunId } from "@caelush/protocol";

/** Restricted durable facts needed before an old ordinary resource wait can be closed safely. */
export type LegacyPendingToolCallInspection =
  | {
      readonly externalCallId: string;
      readonly toolName: string;
      readonly kind: "NOT_DISPATCHED";
    }
  | {
      readonly externalCallId: string;
      readonly toolName: string;
      readonly kind: "SETTLED";
      readonly observation: {
        readonly runId: RunId;
        readonly sourceStepId: string;
        readonly invocationId: string;
        readonly observationId: string;
        readonly content: string;
        readonly isError: boolean;
      };
      readonly message: {
        readonly messageId: string;
        readonly content: string;
        readonly isError: boolean;
      };
    }
  | {
      readonly externalCallId: string;
      readonly toolName: string;
      readonly kind: "REQUESTED" | "RUNNING_UNKNOWN" | "INVALID";
      readonly reasonCode?: "MISSING_OBSERVATION" | "IDENTITY_MISMATCH" | "UNSUPPORTED_STATUS";
    }
  | {
      readonly externalCallId: string;
      readonly toolName: string;
      readonly kind: "WAITING_APPROVAL";
      readonly invocationId: string;
      readonly approvalId?: string | undefined;
    };

export interface LegacyPendingBatchInspectionPort {
  inspect(input: {
    readonly runId: RunId;
    readonly sourceStepId: string;
    readonly calls: readonly {
      readonly externalCallId: string;
      readonly toolName: string;
    }[];
  }): Promise<readonly LegacyPendingToolCallInspection[]>;
}

/** Existing Tool lifecycle authority for closing a pre-execution REQUESTED invocation. */
export interface LegacyPendingBatchDispatcherPort {
  cancelUnstarted(input: {
    readonly runId: RunId;
    readonly sourceStepId: string;
    readonly externalCallId: string;
    readonly toolName: string;
  }): Promise<void>;
}
