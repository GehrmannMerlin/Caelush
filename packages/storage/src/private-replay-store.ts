import { isDeepStrictEqual } from "node:util";
import {
  assertPrivateReplayIdentity,
  createPrivateReplayReference,
  PRIVATE_REPLAY_REFERENCE_KIND,
  PrivateReplayError,
} from "@caelush/agent";
import type {
  AgentMessageRecordDraft,
  EncryptedPrivateReplay,
  PrivateReplayIdentity,
  PrivateReplayReadScope,
  PrivateReplayStorePort,
  PrivateReplayWrite,
  ReplayProtectionPort,
} from "@caelush/agent";
import type { CaelushDatabase } from "./database.js";

interface ReplayRow {
  message_id: string;
  run_id: string;
  session_id: string;
  identity_json: string;
  envelope_json: string;
}
interface ValidatedPrivateReplayWrite extends PrivateReplayWrite {
  /** Exact row authenticated before BEGIN; detects an interleaving writer before this commit. */
  readonly existingAtValidation?: Pick<ReplayRow, "identity_json" | "envelope_json">;
}
/** Internal capability, deliberately absent from the package public entry point. */
export const PRIVATE_REPLAY_COMMIT = Symbol("private replay commit");

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function hasPrivateReplayReference(draft: AgentMessageRecordDraft): boolean {
  return object(object(draft.data.providerState).payload).kind === PRIVATE_REPLAY_REFERENCE_KIND;
}

function assertMessage(
  identity: PrivateReplayIdentity,
  message:
    | {
        readonly message_id: string;
        readonly run_id: string;
        readonly session_id: string;
        readonly message_type: string;
        readonly data_json: string;
        readonly source_json: string;
      }
    | undefined,
): void {
  if (message === undefined) throw new PrivateReplayError();
  const data = object(JSON.parse(message.data_json));
  const model = object(data.model);
  const ref = object(model.model);
  const source = object(JSON.parse(message.source_json));
  if (
    message.message_id !== identity.messageId ||
    message.run_id !== identity.runId ||
    message.session_id !== identity.sessionId ||
    message.message_type !== "ASSISTANT" ||
    model.kind !== "MODEL_TURN" ||
    model.callId !== identity.callId ||
    source.kind !== "MODEL" ||
    source.callId !== identity.callId ||
    ref.provider !== identity.providerId ||
    ref.model !== identity.model ||
    !isDeepStrictEqual(data.providerState, createPrivateReplayReference(identity))
  )
    throw new PrivateReplayError();
}

/** Internal transaction collaborator. Only the port is exposed by CaelushStorage. */
export class SqlitePrivateReplayStore implements PrivateReplayStorePort {
  constructor(
    private readonly database: CaelushDatabase,
    private readonly protection?: ReplayProtectionPort,
  ) {}

  async prepare(identity: PrivateReplayIdentity, content: Uint8Array): Promise<PrivateReplayWrite> {
    try {
      assertPrivateReplayIdentity(identity);
      const bound = Object.freeze({ ...identity });
      if (this.protection === undefined) throw new PrivateReplayError();
      return Object.freeze({
        identity: bound,
        envelope: await this.protection.seal(bound, content),
      });
    } catch {
      throw new PrivateReplayError();
    }
  }

  forExecution(scope: PrivateReplayReadScope) {
    const bound = { ...scope, selectedMessageIds: new Set(scope.selectedMessageIds) };
    return Object.freeze({
      read: async (identity: PrivateReplayIdentity): Promise<Uint8Array> => {
        try {
          assertPrivateReplayIdentity(identity);
          const requested = Object.freeze({ ...identity });
          if (
            this.protection === undefined ||
            requested.sessionId !== bound.sessionId ||
            requested.providerId !== bound.providerId ||
            requested.model !== bound.model ||
            requested.api !== bound.api ||
            !bound.selectedMessageIds.has(requested.messageId)
          )
            throw new PrivateReplayError();
          const execution = this.database.client
            .prepare("SELECT session_id FROM agent_runs WHERE id = ?")
            .get(bound.executionRunId);
          if (execution?.session_id !== bound.sessionId) throw new PrivateReplayError();
          const sourceRun = this.database.client
            .prepare("SELECT session_id FROM agent_runs WHERE id = ?")
            .get(requested.runId);
          if (sourceRun?.session_id !== bound.sessionId) throw new PrivateReplayError();
          const row = this.row(requested.messageId);
          if (
            row === undefined ||
            row.run_id !== requested.runId ||
            row.session_id !== requested.sessionId ||
            !isDeepStrictEqual(JSON.parse(row.identity_json), requested)
          )
            throw new PrivateReplayError();
          this.assertStoredMessage(requested);
          return await this.protection.open(
            requested,
            JSON.parse(row.envelope_json) as EncryptedPrivateReplay,
          );
        } catch {
          throw new PrivateReplayError();
        }
      },
    });
  }

  /** Authenticates before BEGIN; no key lookup or await is performed inside a SQLite transaction. */
  async validateWrites(
    writes: readonly PrivateReplayWrite[],
  ): Promise<readonly ValidatedPrivateReplayWrite[]> {
    try {
      if (writes.length > 16) throw new PrivateReplayError();
      const copied: PrivateReplayWrite[] = writes.map((write) => ({
        identity: Object.freeze({ ...write.identity }),
        envelope: Object.freeze({ ...write.envelope }),
      }));
      if (
        new Set(copied.map((write) => write.identity.messageId)).size !== copied.length ||
        copied.reduce((sum, write) => sum + write.envelope.ciphertext.length, 0) > 32 * 1024 * 1024
      )
        throw new PrivateReplayError();
      const validated: ValidatedPrivateReplayWrite[] = [];
      for (const write of copied) {
        if (this.protection === undefined) throw new PrivateReplayError();
        await this.protection.verify(write.identity, write.envelope);
        const existing = this.row(write.identity.messageId);
        let existingAtValidation: ValidatedPrivateReplayWrite["existingAtValidation"];
        if (existing !== undefined) {
          if (!isDeepStrictEqual(JSON.parse(existing.identity_json), write.identity))
            throw new PrivateReplayError();
          await this.protection.verify(
            write.identity,
            JSON.parse(existing.envelope_json) as EncryptedPrivateReplay,
          );
          existingAtValidation = Object.freeze({
            identity_json: existing.identity_json,
            envelope_json: existing.envelope_json,
          });
        }
        validated.push(
          Object.freeze(
            existingAtValidation === undefined ? write : { ...write, existingAtValidation },
          ),
        );
      }
      return validated;
    } catch {
      throw new PrivateReplayError();
    }
  }

  /** Caller owns BEGIN/COMMIT. Every reference and identity is rechecked against transaction truth. */
  writeInTransaction(
    runId: string,
    writes: readonly ValidatedPrivateReplayWrite[],
    messages: readonly AgentMessageRecordDraft[],
  ): void {
    try {
      const supplied = new Set(writes.map((write) => write.identity.messageId));
      for (const message of messages) {
        if (hasPrivateReplayReference(message) && !supplied.has(message.messageId))
          throw new PrivateReplayError();
      }
      for (const write of writes) {
        const { identity, envelope } = write;
        if (identity.runId !== runId) throw new PrivateReplayError();
        const run = this.database.client
          .prepare("SELECT session_id FROM agent_runs WHERE id = ?")
          .get(runId);
        if (run?.session_id !== identity.sessionId) throw new PrivateReplayError();
        this.assertStoredMessage(identity);
        const existing = this.row(identity.messageId);
        if (existing !== undefined) {
          const previous = JSON.parse(existing.envelope_json) as EncryptedPrivateReplay;
          if (
            write.existingAtValidation === undefined ||
            existing.identity_json !== write.existingAtValidation.identity_json ||
            existing.envelope_json !== write.existingAtValidation.envelope_json ||
            !isDeepStrictEqual(JSON.parse(existing.identity_json), identity) ||
            previous.keyId !== envelope.keyId ||
            previous.contentMac !== envelope.contentMac
          )
            throw new PrivateReplayError();
          continue;
        }
        this.database.client
          .prepare(
            "INSERT INTO private_replays (message_id, run_id, session_id, identity_json, envelope_json, key_id, nonce) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            identity.messageId,
            identity.runId,
            identity.sessionId,
            JSON.stringify(identity),
            JSON.stringify(envelope),
            envelope.keyId,
            envelope.nonce,
          );
      }
    } catch {
      throw new PrivateReplayError();
    }
  }

  private row(messageId: string): ReplayRow | undefined {
    return this.database.client
      .prepare("SELECT * FROM private_replays WHERE message_id = ?")
      .get(messageId) as ReplayRow | undefined;
  }

  private assertStoredMessage(identity: PrivateReplayIdentity): void {
    const message = this.database.client
      .prepare(
        "SELECT message_id, run_id, session_id, message_type, data_json, source_json FROM agent_messages WHERE message_id = ?",
      )
      .get(identity.messageId) as Parameters<typeof assertMessage>[1];
    assertMessage(identity, message);
  }
}
