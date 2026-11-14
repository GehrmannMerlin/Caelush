import { SkillIdSchema } from "@caelush/protocol";
import type { CaelushDatabase } from "./database.js";

export interface SkillSettingsRecord {
  readonly skillId: string;
  readonly enabled: boolean;
  readonly modelInvocable?: boolean;
  readonly version: number;
  readonly updatedAtMs: number;
}

export interface SkillSettingsPatch {
  readonly enabled?: boolean;
  readonly modelInvocable?: boolean;
}

export interface SkillSettingsUpdateResult {
  readonly ok: boolean;
  readonly settings: SkillSettingsRecord;
}

export interface SkillSettingsRepository {
  get(skillId: string): Promise<SkillSettingsRecord>;
  getMany(skillIds: readonly string[]): Promise<ReadonlyMap<string, SkillSettingsRecord>>;
  compareAndSwap(input: {
    readonly skillId: string;
    readonly expectedVersion: number;
    readonly patch: SkillSettingsPatch;
  }): Promise<SkillSettingsUpdateResult>;
}

interface SkillSettingsRow {
  readonly skill_id: string;
  readonly enabled: number;
  readonly model_invocable: number | null;
  readonly version: number;
  readonly updated_at_ms: number;
}

export class SqliteSkillSettingsRepository implements SkillSettingsRepository {
  constructor(private readonly database: CaelushDatabase) {}

  async get(skillId: string): Promise<SkillSettingsRecord> {
    const normalizedId = SkillIdSchema.parse(skillId);
    return decode(
      this.database.client
        .prepare("SELECT * FROM skill_settings WHERE skill_id = ?")
        .get(normalizedId) as SkillSettingsRow | undefined,
      normalizedId,
    );
  }

  async getMany(skillIds: readonly string[]): Promise<ReadonlyMap<string, SkillSettingsRecord>> {
    const normalizedIds = [...new Set(skillIds.map((skillId) => SkillIdSchema.parse(skillId)))];
    const records = new Map<string, SkillSettingsRecord>();
    if (normalizedIds.length === 0) return records;

    const statement = this.database.client.prepare(
      "SELECT * FROM skill_settings WHERE skill_id = ?",
    );
    for (const skillId of normalizedIds) {
      records.set(skillId, decode(statement.get(skillId) as SkillSettingsRow | undefined, skillId));
    }
    return records;
  }

  async compareAndSwap(input: {
    readonly skillId: string;
    readonly expectedVersion: number;
    readonly patch: SkillSettingsPatch;
  }): Promise<SkillSettingsUpdateResult> {
    const skillId = SkillIdSchema.parse(input.skillId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new RangeError("Skill settings version must be a nonnegative safe integer.");
    }
    if (input.patch.enabled === undefined && input.patch.modelInvocable === undefined) {
      throw new TypeError("At least one Skill setting must be provided.");
    }

    const client = this.database.client;
    client.exec("BEGIN IMMEDIATE");
    try {
      const existing = client
        .prepare("SELECT * FROM skill_settings WHERE skill_id = ?")
        .get(skillId) as SkillSettingsRow | undefined;
      const current = decode(existing, skillId);
      if (current.version !== input.expectedVersion) {
        client.exec("ROLLBACK");
        return { ok: false, settings: current };
      }

      const nextVersion = current.version + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        throw new RangeError("Skill settings version is outside the safe integer range.");
      }
      const next: SkillSettingsRecord = Object.freeze({
        skillId,
        enabled: input.patch.enabled ?? current.enabled,
        ...(input.patch.modelInvocable === undefined
          ? current.modelInvocable === undefined
            ? {}
            : { modelInvocable: current.modelInvocable }
          : { modelInvocable: input.patch.modelInvocable }),
        version: nextVersion,
        updatedAtMs: Date.now(),
      });

      client
        .prepare(
          `INSERT INTO skill_settings (skill_id, enabled, model_invocable, version, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(skill_id) DO UPDATE SET
             enabled = excluded.enabled,
             model_invocable = excluded.model_invocable,
             version = excluded.version,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          skillId,
          next.enabled ? 1 : 0,
          next.modelInvocable === undefined ? null : next.modelInvocable ? 1 : 0,
          next.version,
          next.updatedAtMs,
        );
      client.exec("COMMIT");
      return { ok: true, settings: next };
    } catch (error) {
      try {
        client.exec("ROLLBACK");
      } catch {
        // Preserve the operation error; SQLite has already rolled the transaction back.
      }
      throw error;
    }
  }
}

function decode(row: SkillSettingsRow | undefined, skillId: string): SkillSettingsRecord {
  if (row === undefined) {
    return Object.freeze({ skillId, enabled: true, version: 0, updatedAtMs: 0 });
  }
  if (
    row.skill_id !== skillId ||
    (row.enabled !== 0 && row.enabled !== 1) ||
    (row.model_invocable !== null && row.model_invocable !== 0 && row.model_invocable !== 1) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < 0
  ) {
    throw new Error("Stored Skill settings are invalid.");
  }
  return Object.freeze({
    skillId,
    enabled: row.enabled === 1,
    ...(row.model_invocable === null ? {} : { modelInvocable: row.model_invocable === 1 }),
    version: row.version,
    updatedAtMs: row.updated_at_ms,
  });
}
