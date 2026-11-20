import { afterEach, describe, expect, it } from "vitest";
import { isTerminalRunStatus } from "@caelush/core";
import { startSkillAcceptanceScenario, type ScenarioHandle } from "./support/skills-fixtures.js";

const scenarios: ScenarioHandle[] = [];

afterEach(async () => {
  await Promise.all(scenarios.splice(0).map((scenario) => scenario.dispose()));
});

describe("Phase 08 production Skill fault recovery", () => {
  it("A15 keeps the committed Run and ordered events when live notification fails", async () => {
    const scenario = await startSkillAcceptanceScenario({
      caseId: "A15",
      faultPoint: "AFTER_COMMIT_BEFORE_NOTIFY",
      policy: "VIEW_ONLY",
      profile: "ONE_SKILL",
    });
    scenarios.push(scenario);

    await expect(scenario.createRun()).rejects.toThrow();
    const [runId] = await scenario.readRunIds();
    expect(runId).toBeDefined();
    const facts = await scenario.inspectDurableFacts(runId!);
    expect(facts.runCount).toBe(1);
    expect(facts.bindingCount).toBe(1);
    expect(facts.eventSequences.length).toBeGreaterThan(0);
    expect(facts.eventSequences).toEqual(
      Array.from({ length: facts.eventSequences.length }, (_, index) => index + 1),
    );
    const replayed = await scenario.readReplayFirstEvent(runId!);
    expect(replayed).not.toBeNull();
    expect(facts.eventSequences).toContain(replayed?.sequence);
    expect((await scenario.inspect()).providerCalls).toBe(0);
  }, 30_000);

  it("A16 does not resend a Provider turn after an abrupt daemon process exit", async () => {
    const scenario = await startSkillAcceptanceScenario({
      caseId: "A16",
      faultPoint: "PROVIDER_STARTED",
      policy: "VIEW_ONLY",
      profile: "ONE_SKILL",
    });
    scenarios.push(scenario);

    const run = await scenario.createRun();
    await scenario.startRun(run.id);
    await scenario.waitForProviderStarted();
    expect(await scenario.inspect()).toMatchObject({ providerCalls: 1, bindingCount: 1 });

    await scenario.restart();
    const recovered = await scenario.waitForRun(run.id);
    expect(isTerminalRunStatus(recovered.status)).toBe(true);
    expect((await scenario.inspect()).providerCalls).toBe(1);
    expect(await scenario.inspectDurableFacts(run.id)).toMatchObject({
      runCount: 1,
      bindingCount: 1,
    });
    expect(scenario.requestEvidence()).toHaveLength(1);
  }, 30_000);

  it("A11 rolls back the Run and prepared binding when the creation commit fails", async () => {
    const scenario = await startSkillAcceptanceScenario({
      caseId: "A11",
      faultPoint: "RUN_BEFORE_COMMIT",
      policy: "VIEW_ONLY",
      profile: "ONE_SKILL",
    });
    scenarios.push(scenario);

    await expect(scenario.createRun()).rejects.toThrow();
    await expect(scenario.inspect()).resolves.toMatchObject({ runCount: 0, bindingCount: 0 });
    expect(scenario.requestEvidence()).toEqual([]);
  }, 30_000);

  it("A12 leaves no observation or binding when Tool settlement cannot commit", async () => {
    const scenario = await startSkillAcceptanceScenario({
      caseId: "A12",
      faultPoint: "TOOL_BEFORE_COMMIT",
      policy: "VIEW_ONLY",
      profile: "DISCOVERABLE_SKILL",
    });
    scenarios.push(scenario);

    const run = await scenario.createRun();
    await scenario.startRun(run.id);
    await scenario.waitForRun(run.id);

    const facts = await scenario.inspectDurableFacts(run.id);
    expect(facts.bindingCount).toBe(0);
    expect(facts.observationCount).toBe(0);
    expect(facts.invocationStatuses).toEqual(["RUNNING"]);
    expect(facts.eventSequences).toEqual(
      Array.from({ length: facts.eventSequences.length }, (_, index) => index + 1),
    );
    expect(scenario.requestEvidence().length).toBeGreaterThan(0);
    expect(scenario.providerToolNames()[0]).toContain("read_skill");
  }, 30_000);

  it("A13 rolls back receipts and prevents Provider I/O on Step commit failure", async () => {
    const scenario = await startSkillAcceptanceScenario({
      caseId: "A13",
      faultPoint: "STEP_BEFORE_COMMIT",
      policy: "VIEW_ONLY",
      profile: "ONE_SKILL",
    });
    scenarios.push(scenario);

    const run = await scenario.createRun();
    await scenario.startRun(run.id);
    await scenario.waitForRun(run.id);

    const facts = await scenario.inspect();
    expect(facts.receiptCount).toBe(0);
    expect(facts.providerCalls).toBe(0);
    expect(facts.scriptLaunches).toBe(0);
    expect(await scenario.inspectDurableFacts(run.id)).toMatchObject({
      runCount: 1,
      bindingCount: 1,
      stepCount: 0,
      receiptCount: 0,
    });
  }, 30_000);
});
