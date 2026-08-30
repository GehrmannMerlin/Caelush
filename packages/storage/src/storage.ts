import { migrateCaelushDatabase } from "./migrate.js";
import { openCaelushDatabase } from "./database.js";
import {
  SqliteSessionRepository,
  type SessionRepository,
} from "./repositories/session-repository.js";
import { SqliteRunRepository, type RunRepository } from "./repositories/run-repository.js";
import { SqliteStepRepository, type StepRepository } from "./repositories/step-repository.js";
import {
  SqliteRunStateRepository,
  type RunStateRepository,
} from "./repositories/run-state-repository.js";
import { SqliteDurableEventStore } from "./events/sqlite-durable-event-store.js";
import type { DurableEventStore } from "@caelush/events";
import {
  SqliteConversationRepository,
  type ConversationRepository,
} from "./repositories/conversation-repository.js";
import {
  SqliteContinuationRepository,
  type ContinuationRepository,
} from "./repositories/continuation-repository.js";
import { SqliteRunExecutionStore } from "./run-execution-store.js";
import type { RunExecutionStorePort } from "@caelush/core";
import { SqliteToolExecutionStore } from "./tool-execution-store.js";
import type { ToolExecutionStorePort } from "@caelush/tools";
import {
  SqliteToolInvocationRepository,
  type ToolInvocationRepository,
} from "./repositories/tool-invocation-repository.js";
import {
  SqliteObservationRepository,
  type ObservationRepository,
} from "./repositories/observation-repository.js";
import {
  SqliteApprovalRepository,
  type ApprovalRepository,
} from "./repositories/approval-repository.js";
import type { ApprovalClock } from "./repositories/approval-repository.js";
import {
  SqliteCancellationRepository,
  type CancellationRepository,
} from "./cancellation-repository.js";

export interface CaelushStorage {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly steps: StepRepository;
  readonly runStates: RunStateRepository;
  readonly events: DurableEventStore;
  readonly messages: ConversationRepository;
  readonly continuations: ContinuationRepository;
  readonly execution: RunExecutionStorePort;
  readonly toolExecution: ToolExecutionStorePort;
  readonly toolInvocations: ToolInvocationRepository;
  readonly observations: ObservationRepository;
  readonly approvals: ApprovalRepository;
  readonly cancellations: CancellationRepository;
  close(): Promise<void>;
}

export async function openCaelushStorage(options: {
  path: string;
  approvalClock?: ApprovalClock;
}): Promise<CaelushStorage> {
  const database = await openCaelushDatabase(options);

  try {
    await migrateCaelushDatabase(database);
    return {
      sessions: new SqliteSessionRepository(database),
      runs: new SqliteRunRepository(database),
      steps: new SqliteStepRepository(database),
      runStates: new SqliteRunStateRepository(database),
      events: new SqliteDurableEventStore(database),
      messages: new SqliteConversationRepository(database),
      continuations: new SqliteContinuationRepository(database),
      execution: new SqliteRunExecutionStore(database),
      toolExecution: new SqliteToolExecutionStore(database),
      toolInvocations: new SqliteToolInvocationRepository(database),
      observations: new SqliteObservationRepository(database),
      approvals: new SqliteApprovalRepository(
        database,
        options.approvalClock === undefined ? {} : { clock: options.approvalClock },
      ),
      cancellations: new SqliteCancellationRepository(database),
      close: async () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
