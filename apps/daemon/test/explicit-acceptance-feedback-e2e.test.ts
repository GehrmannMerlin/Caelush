import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AIAdapterEvent, ApiAdapter, ApiAdapterStreamInput, ApiId } from "@caelush/ai";
import { afterEach, describe, expect, it } from "vitest";

import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { FIXTURE_API } from "./support/reliability-fixture.js";
import { createReliabilityFixture } from "./support/reliability-fixture.js";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe("explicit acceptance feedback across the production Run path", () => {
  it("repairs a failed required test and only completes after the next test passes", async () => {
    const adapter = new ExplicitAcceptanceAdapter();
    const fixture = await createReliabilityFixture({
      adapter,
      permissionPreset: "FULL_ACCESS",
      goal: "Change target.txt to PASS and do not finish until pnpm run test passes.",
      acceptanceRequirements: [{ source: "USER_EXPLICIT", purpose: "TEST" }],
    });
    disposers.push(() => fixture.dispose());

    await writeFile(
      join(fixture.workspacePath, "package.json"),
      JSON.stringify({
        name: "explicit-acceptance-fixture",
        version: "1.0.0",
        packageManager: "pnpm@11.21.0",
        scripts: { test: "node verify.mjs" },
      }),
      "utf8",
    );
    await writeFile(join(fixture.workspacePath, "target.txt"), "FAIL\n", "utf8");
    await writeFile(
      join(fixture.workspacePath, "verify.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        'const value = readFileSync(new URL("./target.txt", import.meta.url), "utf8").trim();',
        'if (value !== "PASS") { process.stderr.write("required test failed\\n"); process.exitCode = 1; }',
        'else process.stdout.write("required test passed\\n");',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(result.run.status).toBe("COMPLETED");
    expect(fixture.run.acceptanceRequirements).toEqual([
      { source: "USER_EXPLICIT", purpose: "TEST" },
    ]);
    expect(adapter.repairFeedback).toContain("Verification repair context");
    expect(adapter.repairFeedback).toContain("TEST");
    expect(adapter.repairFeedback).toContain("FAILED");
    expect(adapter.repairToolResult).toContain("apply_patch");
    expect(adapter.repairToolResult).toContain("target.txt");
    expect(await readFile(join(fixture.workspacePath, "target.txt"), "utf8")).toBe("PASS\n");

    const plans = await fixture.storage.verification.listPlans(fixture.run.id);
    expect(plans).toHaveLength(2);
    const checks = await Promise.all(
      plans.map(async (plan) => fixture.storage.verification.listChecks(plan.id)),
    );
    expect(
      checks.map((planChecks) =>
        planChecks
          .filter(
            (check) =>
              check.spec.kind === "PROJECT" &&
              check.spec.purpose === "TEST" &&
              check.spec.source === "USER",
          )
          .map((check) => check.status),
      ),
    ).toEqual([["FAILED"], ["PASSED"]]);
    expect((await fixture.storage.runs.get(fixture.run.id))?.completionDisposition).toBeUndefined();
  }, 90_000);

  it("preserves an explicit unmet requirement as a typed INCOMPLETE disposition", async () => {
    const adapter = new NeverRepairsAcceptanceAdapter();
    const fixture = await createReliabilityFixture({
      adapter,
      permissionPreset: "FULL_ACCESS",
      goal: "Do not finish until pnpm run test passes.",
      acceptanceRequirements: [{ source: "USER_EXPLICIT", purpose: "TEST" }],
    });
    disposers.push(() => fixture.dispose());

    await writeFile(
      join(fixture.workspacePath, "package.json"),
      JSON.stringify({
        name: "explicit-acceptance-failure-fixture",
        version: "1.0.0",
        packageManager: "pnpm@11.21.0",
        scripts: { test: "node verify.mjs" },
      }),
      "utf8",
    );
    await writeFile(
      join(fixture.workspacePath, "verify.mjs"),
      [
        'process.stderr.write("required test remains failed\\\\n");',
        "process.exitCode = 1;",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(result.run.status).toBe("FAILED");
    expect(result.run.completionDisposition).toMatchObject({
      version: "COMPLETION_DISPOSITION_V1",
      type: "INCOMPLETE",
      reasonCode: "ACCEPTANCE_NOT_MET",
      requirementSources: ["USER_EXPLICIT"],
    });
  }, 90_000);
});

class NeverRepairsAcceptanceAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;

  stream(): AsyncIterable<AIAdapterEvent> {
    return this.respond();
  }

  private async *respond(): AsyncGenerator<AIAdapterEvent> {
    yield* answer("The requested change is complete.");
  }
}

class ExplicitAcceptanceAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  private mainTurn = 0;
  repairFeedback = "";
  repairToolResult = "";

  stream(input: ApiAdapterStreamInput): AsyncIterable<AIAdapterEvent> {
    return this.respond(input);
  }

  private async *respond(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    const messages = input.request.messages;
    const serialized = JSON.stringify(messages);
    if (messages[0]?.content.includes("Review the supplied task bundle independently.")) {
      throw new Error("A project-test acceptance requirement must not invoke the task reviewer.");
    }

    this.mainTurn += 1;
    if (this.mainTurn === 1) {
      // Deliberately premature: the required test is the authority that must reject this candidate.
      yield* answer("The requested change is complete.");
      return;
    }
    if (this.mainTurn === 2) {
      this.repairFeedback = serialized;
      if (!serialized.includes("Verification repair context")) {
        throw new Error("The failed explicit check was not carried into the repair turn.");
      }
      yield* toolCall("repair-acceptance-test", "apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Update File: target.txt",
          "@@",
          "-FAIL",
          "+PASS",
          "*** End Patch",
        ].join("\n"),
      });
      yield finish("TOOL_CALLS");
      return;
    }
    if (this.mainTurn === 3) {
      this.repairToolResult = serialized;
      if (!serialized.includes("repair-acceptance-test")) {
        throw new Error("The patch result was not returned to the model before it finalized.");
      }
      yield* answer("The explicit test has now passed after the repair.");
      return;
    }
    throw new Error("The acceptance scenario advanced beyond its expected repair cycle.");
  }
}
