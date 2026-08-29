import { createRunId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

describe("ObservationRepository", () => {
  it("lists durable observations by run", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    try {
      await expect(storage.observations.listByRun(createRunId())).resolves.toEqual([]);
    } finally {
      await storage.close();
    }
  });
});
