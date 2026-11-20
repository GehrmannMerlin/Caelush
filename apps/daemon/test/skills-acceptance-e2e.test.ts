import { afterEach, describe, expect, it } from "vitest";
import { createSkillCapabilityResponse } from "../src/skills/feature-policy.js";
import {
  createSkillCompositionFixture,
  startSkillAcceptanceScenario,
  type SkillCompositionFixture,
  type ScenarioHandle,
} from "./support/skills-fixtures.js";

const fixtures: SkillCompositionFixture[] = [];
const scenarios: ScenarioHandle[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.dispose()));
});

describe("Phase 08 production Skill composition readiness", () => {
  it("A01 composes the stable 16-tool schema when the enabled Skill catalog is empty", async () => {
    const scenario = await startSkillAcceptanceScenario({
      caseId: "A01",
      policy: "VIEW_ONLY",
      profile: "EMPTY_SKILLS",
    });
    scenarios.push(scenario);

    const run = await scenario.createRun();
    await scenario.startRun(run.id);
    await scenario.waitForRun(run.id);

    expect(scenario.skillId).toBeUndefined();
    expect((await scenario.inspect()).bindingCount).toBe(0);
    expect(scenario.providerToolNames()[0]).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "apply_patch",
      "update_plan",
      "exec_command",
      "write_stdin",
      "stop_process",
      "git_status",
      "git_diff",
      "read_attachment",
      "read_history",
      "search_skills",
      "read_skill",
      "run_skill_script",
    ]);
  }, 30_000);

  it("A22 preserves 16 tools when ON and 13 tools when OFF", async () => {
    const enabled = await startSkillAcceptanceScenario({
      caseId: "A22-on",
      policy: "VIEW_ONLY",
      profile: "EMPTY_SKILLS",
    });
    const disabled = await startSkillAcceptanceScenario({
      caseId: "A22-off",
      policy: "VIEW_ONLY",
      profile: "OFF",
    });
    scenarios.push(enabled, disabled);

    for (const scenario of [enabled, disabled]) {
      const run = await scenario.createRun();
      await scenario.startRun(run.id);
      await scenario.waitForRun(run.id);
    }

    expect(enabled.providerToolNames()[0]).toHaveLength(16);
    expect(disabled.providerToolNames()[0]).toHaveLength(13);
    expect((await disabled.inspect()).bindingCount).toBe(0);
  }, 45_000);

  it("does not advertise Skill invocation when the bundle resolver is missing", async () => {
    const fixture = await createSkillCompositionFixture({ artifactStoreAvailable: false });
    fixtures.push(fixture);

    const capabilities = createSkillCapabilityResponse(fixture.composition.skillFeatureReadiness);
    expect(capabilities).toMatchObject({ enabled: true, catalog: false, invocation: false });
  });

  it.each([
    ["prepared-resource transaction", "insertRunWithPreparedResources"],
    ["receipt reader", "readPreparedInputReceipts"],
  ] as const)(
    "does not advertise Skill invocation when the %s adapter is missing",
    async (_name, missingRunCapability) => {
      const fixture = await createSkillCompositionFixture({ missingRunCapability });
      fixtures.push(fixture);

      const capabilities = createSkillCapabilityResponse(fixture.composition.skillFeatureReadiness);
      expect(capabilities.enabled).toBe(true);
      expect(capabilities.invocation).toBe(false);
    },
  );
});
