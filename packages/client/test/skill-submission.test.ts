import {
  createRunId,
  createSessionId,
  SubmissionSkillPreparationV1Schema,
} from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushClient } from "../src/client.js";

describe("CaelushClient Skill submission recovery", () => {
  it("reads bounded CONTENT_READY draft metadata through the owning Session route", async () => {
    const sessionId = createSessionId();
    const runId = createRunId();
    const requests: Request[] = [];
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return json({
          schemaVersion: 1,
          runId,
          userText: "continue my draft",
          preparationStatus: "CONTENT_READY",
          selectedSkills: [{ skillId: "project:review", name: "review-helper" }],
        });
      },
    });

    await expect(client.getSubmissionSkillPreparation(sessionId, runId)).resolves.toEqual({
      schemaVersion: 1,
      runId,
      userText: "continue my draft",
      preparationStatus: "CONTENT_READY",
      selectedSkills: [{ skillId: "project:review", name: "review-helper" }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe(
      `/api/v1/sessions/${sessionId}/runs/${runId}/skill-preparation`,
    );
  });

  it("rejects recovery responses that contain Skill bodies or a fabricated LOADED state", () => {
    expect(
      SubmissionSkillPreparationV1Schema.safeParse({
        schemaVersion: 1,
        runId: createRunId(),
        userText: "draft",
        preparationStatus: "LOADED",
        selectedSkills: [],
        body: "private skill instructions",
      }).success,
    ).toBe(false);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
