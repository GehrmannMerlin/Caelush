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
import { SqliteAgentMessageRecordStore } from "./messages/sqlite-agent-message-record-store.js";
import {
  SqliteContinuationRepository,
  type ContinuationRepository,
} from "./repositories/continuation-repository.js";
import { SqliteRunExecutionStore } from "./run-execution-store.js";
import { SqliteToolExecutionStore } from "./tool-execution-store.js";
import type { ToolSettlementExtensionDecoder } from "./tool-settlement-extension-adapter.js";
import type { ToolExecutionStorePort } from "@caelush/agent";
import type { DurableRunEventReaderPort } from "@caelush/agent";
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
import { SqliteBudgetLedgerRepository } from "./budget-ledger-repository.js";
import { SqliteRunBudgetPort, type SqliteRunBudgetPortOptions } from "./run-budget-port.js";
import { SqliteResourceGovernanceRepository } from "./resource-governance-repository.js";
import {
  SqliteVerificationRepository,
  type VerificationRepository,
} from "./repositories/verification-repository.js";
import { SqliteVerificationExecutionStore } from "./verification-execution-store.js";
import type { VerificationExecutionRecoveryStorePort } from "@caelush/verification";
import { SqliteMemoryRepository } from "./memory-repository.js";
import type { MemoryStore } from "@caelush/memory";
import {
  SqliteContextArtifactRepository,
  type ContextArtifactRepository,
} from "./context-artifact-repository.js";
import {
  SqliteContextCheckpointRepository,
  type ContextCheckpointRepository,
} from "./context-checkpoint-repository.js";
import { SqliteContextCheckpointRepositoryV2 } from "./context-checkpoint-repository-v2.js";
import type { ContextCheckpointRepositoryPort } from "@caelush/agent";
import { SqliteContextArtifactStore } from "./context-artifact-store.js";
import { SqliteContextUsageStore } from "./context-usage-store.js";
import type { ContextArtifactStorePort, ContextUsageStorePort } from "@caelush/agent";
import { SqliteContextCompactionCommitStore } from "./context-compaction-commit-store.js";
import type { ContextCompactionCommitPort } from "@caelush/agent";
import { SqliteMemoryExtractionJobRepository } from "./memory-extraction-job-repository.js";
import type { MemoryExtractionJobStore } from "@caelush/memory";
import {
  SqliteContextRuntimeStateRepository,
  type ContextRuntimeStateRepository,
} from "./context-runtime-state-repository.js";

export interface CaelushStorage {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly steps: StepRepository;
  readonly runStates: RunStateRepository;
  readonly eventReader: DurableRunEventReaderPort;
  /** The canonical Message V2 record store. */
  readonly messageRecords: SqliteAgentMessageRecordStore;
  readonly continuations: ContinuationRepository;
  readonly execution: SqliteRunExecutionStore;
  readonly toolExecution: ToolExecutionStorePort;
  readonly toolInvocations: ToolInvocationRepository;
  readonly observations: ObservationRepository;
  readonly approvals: ApprovalRepository;
  readonly cancellations: CancellationRepository;
  readonly budgetLedger: SqliteBudgetLedgerRepository;
  readonly budget: SqliteRunBudgetPort;
  readonly resourceGovernance: SqliteResourceGovernanceRepository;
  readonly verification: VerificationRepository;
  readonly verificationExecution: VerificationExecutionRecoveryStorePort;
  readonly memory: MemoryStore;
  readonly memoryExtractionJobs: MemoryExtractionJobStore;
  readonly contextCheckpoints: ContextCheckpointRepository;
  readonly contextCheckpointsV2: ContextCheckpointRepositoryPort;
  readonly contextArtifacts: ContextArtifactRepository;
  readonly contextArtifactsV2: ContextArtifactStorePort;
  readonly contextRuntimeStates: ContextRuntimeStateRepository;
  readonly contextUsage: ContextUsageStorePort;
  readonly contextCompactionCommit: ContextCompactionCommitPort;
  close(): Promise<void>;
}

export async function openCaelushStorage(options: {
  path: string;
  approvalClock?: ApprovalClock;
  budget?: SqliteRunBudgetPortOptions;
  /**
   * How this host projects a Tool settlement extension onto its own `AgentState`.
   *
   * The production composition supplies the Coding Tool effects projection. Absent means this host has
   * no effect vocabulary, and a settlement extension arriving without one is **refused** rather than
   * ignored — a Tool is never recorded `COMPLETED` while the effects it had are unaccounted for.
   */
  toolSettlementExtension?: ToolSettlementExtensionDecoder;
}): Promise<CaelushStorage> {
  const database = await openCaelushDatabase(options);

  try {
    await migrateCaelushDatabase(database);
    const eventStore = new SqliteDurableEventStore(database);
    return {
      sessions: new SqliteSessionRepository(database),
      runs: new SqliteRunRepository(database),
      steps: new SqliteStepRepository(database),
      runStates: new SqliteRunStateRepository(database),
      eventReader: eventStore,
      messageRecords: new SqliteAgentMessageRecordStore(database),
      continuations: new SqliteContinuationRepository(database),
      execution: new SqliteRunExecutionStore(database),
      toolExecution: new SqliteToolExecutionStore(
        database,
        options.toolSettlementExtension === undefined
          ? {}
          : { settlementExtension: options.toolSettlementExtension },
      ),
      toolInvocations: new SqliteToolInvocationRepository(database),
      observations: new SqliteObservationRepository(database),
      approvals: new SqliteApprovalRepository(
        database,
        options.approvalClock === undefined ? {} : { clock: options.approvalClock },
      ),
      cancellations: new SqliteCancellationRepository(database),
      budgetLedger: new SqliteBudgetLedgerRepository(database),
      budget: new SqliteRunBudgetPort(database, options.budget),
      resourceGovernance: new SqliteResourceGovernanceRepository(database),
      verification: new SqliteVerificationRepository(database),
      verificationExecution: new SqliteVerificationExecutionStore(database),
      memory: new SqliteMemoryRepository(database),
      memoryExtractionJobs: new SqliteMemoryExtractionJobRepository(database),
      contextCheckpoints: new SqliteContextCheckpointRepository(database),
      contextCheckpointsV2: new SqliteContextCheckpointRepositoryV2(database),
      contextArtifacts: new SqliteContextArtifactRepository(database),
      contextArtifactsV2: new SqliteContextArtifactStore(database),
      contextRuntimeStates: new SqliteContextRuntimeStateRepository(database),
      contextUsage: new SqliteContextUsageStore(database),
      contextCompactionCommit: new SqliteContextCompactionCommitStore(database),
      close: async () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
