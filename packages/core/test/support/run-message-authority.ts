import {
  createConversationTurn,
  createAgentMessageFactory,
  createAgentMessageIdFactory,
  createDeterministicConversationTurnIdFactory,
  createStandardAgentMessageCodecRegistry,
  createStandardAgentMessageProjectorRegistry,
  createSingleTurnConversationSnapshot,
} from "@caelush/agent";
import { createTimestampMs } from "@caelush/protocol";
import type { RunId } from "@caelush/protocol";

import type { RunMessageAuthority } from "../../src/run-message-materializer.js";
import type { RunExecutionSnapshot } from "../../src/run-execution-store.js";
import type { AgentMessageRecord } from "@caelush/agent";

/** The canonical V2 message authority used by Core and Storage tests. */
export function testRunMessageAuthority(
  options: {
    readonly snapshot?: () => RunExecutionSnapshot;
    /** Optional real V2 record reader for Storage integration tests. */
    readonly records?: (runId: RunId) => Promise<readonly AgentMessageRecord[]>;
  } = {},
): RunMessageAuthority {
  const projectors = createStandardAgentMessageProjectorRegistry();
  const codecs = createStandardAgentMessageCodecRegistry((type) => projectors.currentVersion(type));
  const turns = createDeterministicConversationTurnIdFactory();
  return {
    codecs,
    projectors,
    turns,
    factory: createAgentMessageFactory({
      ids: createAgentMessageIdFactory(),
      now: () => createTimestampMs(1),
      turns,
    }),
    userOrigin: async () => "GOAL",
    conversation: {
      append: async () => [],
      listByRun: async (runId) => {
        const records = (await options.records?.(runId)) ?? [];
        return Object.freeze(records.map((record) => decodeRecord(record, codecs)));
      },
      loadSnapshot: async ({ sessionId, currentRunId }) => {
        if (options.records !== undefined) {
          const records = await options.records(currentRunId);
          return createSingleTurnConversationSnapshot({
            sessionId,
            runId: currentRunId,
            turn: createConversationTurn({
              id: turns.forRun(currentRunId),
              sessionId,
              runId: currentRunId,
              status: "OPEN",
              openedAt: createTimestampMs(1),
              messages: records.map((record) => decodeRecord(record, codecs)),
            }),
          });
        }
        const snapshot = options.snapshot?.();
        if (snapshot === undefined) {
          return createSingleTurnConversationSnapshot({
            sessionId,
            runId: currentRunId,
            turn: createConversationTurn({
              id: turns.forRun(currentRunId),
              sessionId,
              runId: currentRunId,
              status: "OPEN",
              openedAt: createTimestampMs(1),
              messages: [],
            }),
          });
        }
        const records = snapshot.conversationRecords
          .filter((record) => record.runId === currentRunId)
          .map((record) => ({
            sequence: record.sequence,
            schemaVersion: record.schemaVersion,
            ...(record.modelProjectionVersion === undefined
              ? {}
              : { modelProjectionVersion: record.modelProjectionVersion }),
            message: codecs.decode(record),
          }));
        return createSingleTurnConversationSnapshot({
          sessionId,
          runId: currentRunId,
          turn: createConversationTurn({
            id: turns.forRun(currentRunId),
            sessionId,
            runId: currentRunId,
            status: "OPEN",
            openedAt: snapshot.run.createdAt,
            messages: records,
          }),
        });
      },
    },
  };
}

function decodeRecord(
  record: AgentMessageRecord,
  codecs: ReturnType<typeof createStandardAgentMessageCodecRegistry>,
) {
  return Object.freeze({
    sequence: record.sequence,
    schemaVersion: record.schemaVersion,
    ...(record.modelProjectionVersion === undefined
      ? {}
      : { modelProjectionVersion: record.modelProjectionVersion }),
    message: codecs.decode(record),
  });
}
