import { afterEach, describe, expect, it } from "vitest";
import { startSkillAcceptanceScenario, type ScenarioHandle } from "./support/skills-fixtures.js";

const scenarios: ScenarioHandle[] = [];

afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.dispose()));
});

describe("Phase 08 feature switch rollback", () => {
  it("A22 turns off new Skill Runs while restoring an existing Run with its 16-tool profile", async () => {
    const scenario = await startSkillAcceptanceScenario({
      caseId: "A22-rollback",
      policy: "VIEW_ONLY",
      profile: "ONE_SKILL",
    });
    scenarios.push(scenario);

    const existingRun = await scenario.createRun();
    await scenario.setSkillFeatureEnabled(false);
    await scenario.startRun(existingRun.id);
    await expect(scenario.waitForRun(existingRun.id)).resolves.toMatchObject({
      id: existingRun.id,
      status: "COMPLETED",
    });
    expect(scenario.providerToolNames()[0]).toHaveLength(16);

    await expect(scenario.createRun()).rejects.toThrow();
    expect(await scenario.readRunIds()).toEqual([existingRun.id]);

    const legacyRun = await scenario.createRun({ withSkill: false });
    await scenario.startRun(legacyRun.id);
    await expect(scenario.waitForRun(legacyRun.id)).resolves.toMatchObject({
      id: legacyRun.id,
      status: "COMPLETED",
    });
    expect(scenario.providerToolNames()[1]).toHaveLength(13);
    expect((await scenario.inspect()).bindingCount).toBe(1);
  }, 45_000);
});
