import {
  ClientModelSelectionWithReasoningSchema,
  type ClientModelSelectionWithReasoning,
  type ReasoningLevel,
} from "@caelush/protocol";
import type { CaelushDatabase } from "../database.js";
import { StorageError } from "../errors.js";

const DEFAULT_SELECTION_ID = "default";

export interface AISelectionRepository {
  getDefault(): Promise<ClientModelSelectionWithReasoning | undefined>;
  setDefault(selection: ClientModelSelectionWithReasoning): Promise<void>;
  clearDefault(): Promise<void>;
}

interface SelectionRow {
  provider_id: string;
  model_id: string;
  reasoning_level: string | null;
}

export class SqliteAISelectionRepository implements AISelectionRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async getDefault(): Promise<ClientModelSelectionWithReasoning | undefined> {
    try {
      const row = this.database.client
        .prepare(
          `SELECT provider_id, model_id, reasoning_level
           FROM ai_default_selections WHERE id = ?`,
        )
        .get(DEFAULT_SELECTION_ID) as SelectionRow | undefined;
      if (row === undefined) return undefined;
      const value = {
        provider: row.provider_id,
        model: row.model_id,
        ...(row.reasoning_level === null ? {} : { reasoningLevel: row.reasoning_level }),
      };
      return ClientModelSelectionWithReasoningSchema.parse(value);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        throw new StorageError("Stored AI default selection is invalid.", { cause: error });
      }
      throw new StorageError("Unable to read AI default selection.", { cause: error });
    }
  }

  async setDefault(selection: ClientModelSelectionWithReasoning): Promise<void> {
    const parsed = ClientModelSelectionWithReasoningSchema.parse(selection);
    const now = Date.now();
    try {
      this.database.client
        .prepare(
          `INSERT INTO ai_default_selections (id, provider_id, model_id, reasoning_level, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             provider_id = excluded.provider_id,
             model_id = excluded.model_id,
             reasoning_level = excluded.reasoning_level,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          DEFAULT_SELECTION_ID,
          parsed.provider,
          parsed.model,
          parsed.reasoningLevel ?? null,
          now,
        );
    } catch (error) {
      throw new StorageError("Unable to save AI default selection.", { cause: error });
    }
  }

  async clearDefault(): Promise<void> {
    try {
      this.database.client
        .prepare("DELETE FROM ai_default_selections WHERE id = ?")
        .run(DEFAULT_SELECTION_ID);
    } catch (error) {
      throw new StorageError("Unable to clear AI default selection.", { cause: error });
    }
  }
}

// Keep the canonical type visible in the declaration output for callers that need it.
export type { ReasoningLevel };
