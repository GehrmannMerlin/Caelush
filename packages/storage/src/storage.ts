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

export interface CaelushStorage {
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly steps: StepRepository;
  readonly runStates: RunStateRepository;
  readonly events: DurableEventStore;
  readonly messages: ConversationRepository;
  readonly continuations: ContinuationRepository;
  readonly execution: RunExecutionStorePort;
  close(): Promise<void>;
}

export async function openCaelushStorage(options: { path: string }): Promise<CaelushStorage> {
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
      close: async () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
