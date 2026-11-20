import { afterEach, describe, expect, it } from "vitest";
import { startSkillAcceptanceScenario, type ScenarioHandle } from "./support/skills-fixtures.js";

const scenarios: ScenarioHandle[] = [];

afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.dispose()));
});

describe("Phase 08 Skill feature rollback and persisted Run compatibility", () => {
  it("A17/A18/A22 restores the frozen Skill Run after OFF while new Runs use 13 tools", async () => {
    const scenario = await startSkillAcceptanceScenario({
      caseId: "A17-A18-A22",
      policy: "VIEW_ONLY",
      profile: "ONE_SKILL",
    });
    scenarios.push(scenario);

    const existingRun = await scenario.createRun();
    const profile = await scenario.readWorkflowProfile(existingRun.id);
    expect(profile).toMatchObject({
      runId: existingRun.id,
      profileVersion: 1,
      workflowRendererVersion: "workflow-resource@1",
    });
    expect((await scenario.inspect()).bindingCount).toBe(1);

    await scenario.replaceSkillBody("PHASE08_CHANGED_SOURCE_MARKER");
    await scenario.setSkillFeatureEnabled(false);
    await scenario.startRun(existingRun.id);
    await expect(scenario.waitForRun(existingRun.id)).resolves.toMatchObject({
      id: existingRun.id,
      status: "COMPLETED",
    });

    expect(scenario.providerToolNames()[0]).toHaveLength(16);
    expect(scenario.requestContainsText("PHASE08_FROZEN_PRIVATE_GUIDANCE_MARKER")).toBe(true);
    expect(scenario.requestContainsText("PHASE08_CHANGED_SOURCE_MARKER")).toBe(false);
    expect((await scenario.inspect()).receiptCount).toBe(1);

    await expect(scenario.createRun()).rejects.toThrow();
    expect(await scenario.readRunIds()).toHaveLength(1);

    const newLegacyRun = await scenario.createRun({ withSkill: false });
    await scenario.startRun(newLegacyRun.id);
    await expect(scenario.waitForRun(newLegacyRun.id)).resolves.toMatchObject({
      id: newLegacyRun.id,
      status: "COMPLETED",
    });
    expect(scenario.providerToolNames()[1]).toHaveLength(13);
    expect((await scenario.inspect()).bindingCount).toBe(1);
  }, 45_000);
});
