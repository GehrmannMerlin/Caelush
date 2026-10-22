import { createRunId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { CaelushClient } from "../src/client.js";

describe("resource guard client control", () => {
  it("continues the exact Run through the canonical action endpoint", async () => {
    const runId = createRunId();
    let request: Request | undefined;
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({
            runId,
            action: "CONTINUE_RESOURCE",
            disposition: "SCHEDULED",
            run: {
              id: runId,
              sessionId: "ses_0190f8b7-8c15-7abc-8a01-123456789abc",
              goal: "continue",
              status: "WAITING_RESOURCE",
              workspace: { id: "wsp_0190f8b7-8c15-7abc-8a01-123456789abc", path: "/repo" },
              model: { provider: "test", model: "test" },
              runtime: { id: "local", kind: "local" },
              permissionProfile: "READ_ONLY",
              approvalPolicy: "ALWAYS_ASK",
              limits: { maxSteps: 4, maxToolCalls: 4, timeoutMs: 1000 },
              createdAt: 1,
            },
          }),
          { status: 202 },
        );
      },
    });

    await expect(client.continueResourceGuard(runId)).resolves.toMatchObject({ runId });
    expect(request?.url).toBe(`http://daemon.test/api/v1/runs/${runId}/continue-resource`);
    expect(await request?.text()).toBe("");
  });
});

describe("history reference client", () => {
  it("reads a bounded, cursor-addressed source page through the owning Run", async () => {
    const runId = createRunId();
    const sourceRef = `history:v1:${runId}:1:8#1234567890abcdef`;
    let request: Request | undefined;
    const client = new CaelushClient({
      baseUrl: "http://daemon.test",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({
            kind: "PAGE",
            items: [
              {
                messageId: "msg_1",
                sequence: 1,
                role: "USER",
                text: "请读取原文",
                byteLength: 15,
              },
            ],
            nextCursor: "c2",
            sourceRef,
            integrity: "VERIFIED",
            byteCount: 15,
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      client.getRunHistory(runId, { sourceRef, cursor: "c1", maxBytes: 2048 }),
    ).resolves.toMatchObject({ kind: "PAGE", nextCursor: "c2" });
    expect(request?.url).toContain(`/api/v1/runs/${runId}/history?`);
    expect(request?.url).toContain(`sourceRef=${encodeURIComponent(sourceRef)}`);
    expect(request?.url).toContain("cursor=c1");
    expect(request?.url).toContain("maxBytes=2048");
  });
});
