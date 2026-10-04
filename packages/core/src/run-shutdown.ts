/** Why the Run execution scope is being stopped. */
export type RunExecutionStopReason = "USER_CANCELLED" | "MANAGED_RESTART" | "RUN_DEADLINE";

/** Result of asking a Run to reach a safe durable boundary before daemon shutdown. */
export type RunShutdownCheckpointResult = "CHECKPOINTED" | "ALREADY_SAFE" | "UNSAFE_IN_FLIGHT";
