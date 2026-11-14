import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

interface SkillSettingsRecord {
  readonly skillId: string;
  readonly enabled: boolean;
  readonly modelInvocable?: boolean;
  readonly version: number;
  readonly updatedAtMs: number;
}

interface SkillSettingsRepository {
  get(skillId: string): Promise<SkillSettingsRecord>;
  compareAndSwap(input: {
    readonly skillId: string;
    readonly expectedVersion: number;
    readonly patch: { readonly enabled?: boolean; readonly modelInvocable?: boolean };
  }): Promise<{ readonly ok: boolean; readonly settings: SkillSettingsRecord }>;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Skill settings persistence", () => {
  it("uses per-skill versioned CAS and keeps successful updates across reopen", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "caelush-skill-settings-"));
    directories.push(directory);
    const databasePath = path.join(directory, "caelush.db");
    let storage = await openCaelushStorage({ path: databasePath });

    try {
      const repository = (storage as unknown as { skillSettings?: SkillSettingsRepository })
        .skillSettings;
      expect(repository, "storage should expose the Skill settings repository").toBeDefined();
      const settings = repository!;
      const skillId = "skill:v1:settings-cas";

      expect(await settings.get(skillId)).toMatchObject({
        skillId,
        enabled: true,
        version: 0,
      });
      const first = await settings.compareAndSwap({
        skillId,
        expectedVersion: 0,
        patch: { enabled: false, modelInvocable: false },
      });
      expect(first).toMatchObject({
        ok: true,
        settings: { skillId, enabled: false, modelInvocable: false, version: 1 },
      });

      const stale = await settings.compareAndSwap({
        skillId,
        expectedVersion: 0,
        patch: { enabled: true },
      });
      expect(stale).toMatchObject({
        ok: false,
        settings: { enabled: false, modelInvocable: false, version: 1 },
      });

      await storage.close();
      storage = await openCaelushStorage({ path: databasePath });
      const reopened = (storage as unknown as { skillSettings: SkillSettingsRepository })
        .skillSettings;
      expect(await reopened.get(skillId)).toMatchObject({
        skillId,
        enabled: false,
        modelInvocable: false,
        version: 1,
      });
    } finally {
      await storage.close();
    }
  });
});
