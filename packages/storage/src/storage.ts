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
import { SqliteAgentMessageRecordStore } from "./messages/sqlite-agent-message-record-store.js";
import {
  SqliteContinuationRepository,
  type ContinuationRepository,
} from "./repositories/continuation-repository.js";
import { SqliteRunExecutionStore } from "./run-execution-store.js";
import { SqliteToolExecutionStore } from "./tool-execution-store.js";
import type { ToolSettlementExtensionDecoder } from "./tool-settlement-extension-adapter.js";
import type { ToolExecutionStorePort } from "@caelush/agent";
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
  readonly events: DurableEventStore;
  /**
   * The pre-V2 conversation reader and writer.
   *
   * **Phase 5C/5F exit.** This is the compatibility surface the current production Run execution path
   * still uses, and it is deliberately not the canonical one. The canonical V2 surface is
   * {@link CaelushStorage.messageRecords}.
   */
  readonly messages: ConversationRepository;
  /**
   * The Message V2 record store: the target storage authority for a durable agent message.
   *
   * ```text
   * messageRecords   target V2 storage authority
   * messages         temporary production compatibility
   * ```
   *
   * It speaks `AgentMessageRecord` and nothing else: decoding a record into a semantic message belongs
   * to the codec registry, and projecting one belongs to the projector registry.
   */
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
  readonly contextArtifacts: ContextArtifactRepository;
  readonly contextRuntimeStates: ContextRuntimeStateRepository;
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
    return {
      sessions: new SqliteSessionRepository(database),
      runs: new SqliteRunRepository(database),
      steps: new SqliteStepRepository(database),
      runStates: new SqliteRunStateRepository(database),
      events: new SqliteDurableEventStore(database),
      messages: new SqliteConversationRepository(database),
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
      contextArtifacts: new SqliteContextArtifactRepository(database),
      contextRuntimeStates: new SqliteContextRuntimeStateRepository(database),
      close: async () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
