import { createRunId } from "@caelush/protocol";
import { describe, expect, it } from "vitest";
import { openCaelushStorage } from "../src/index.js";

describe("ToolInvocationRepository", () => {
  it("lists durable tool invocations by run", async () => {
    const storage = await openCaelushStorage({ path: ":memory:" });
    try {
      await expect(storage.toolInvocations.listByRun(createRunId())).resolves.toEqual([]);
    } finally {
      await storage.close();
    }
  });
});
