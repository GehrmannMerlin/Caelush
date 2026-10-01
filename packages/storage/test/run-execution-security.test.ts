import { describe, expect, it } from "vitest";
import { createTimestampMs } from "@caelush/protocol";
import { openCaelushStorage } from "../src/index.js";
import { makeRun, makeSession } from "./support/fixtures.js";

describe("Run execution security policy persistence", () => {
  it("preserves the immutable policy snapshot across Run writes", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    try {
      const session = makeSession();
      const run = makeRun(session.id);
      await storage.sessions.insert(session);
      await storage.runs.insert(run);

      const before = (await storage.runs.get(run.id))?.securityPolicy;
      if (before === undefined) throw new Error("fixture did not contain a security policy");
      await storage.runs.update({ ...run, status: "RUNNING", startedAt: createTimestampMs(200) });
      const after = (await storage.runs.get(run.id))?.securityPolicy;

      expect(after).toEqual(before);
      expect(after?.policyDigest).toBe(before.policyDigest);
    } finally {
      await storage.close();
    }
  });
});
