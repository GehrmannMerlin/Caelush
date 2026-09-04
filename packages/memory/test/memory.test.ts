import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryStore,
  MemoryRetriever,
  classifyMemorySensitivity,
  validateMemoryCandidate,
} from "../src/index.js";

describe("scoped durable memory", () => {
  it("requires evidence and rejects secrets", async () => {
    expect(classifyMemorySensitivity("API_KEY=abc")).toBe("SENSITIVE");
    expect(() =>
      validateMemoryCandidate({
        scope: "PROJECT",
        projectId: "project-1",
        topic: "tooling",
        fact: "uses pnpm",
        confidence: 0.9,
        evidenceRefs: [],
        sensitivity: "PUBLIC",
      }),
    ).toThrow(/evidence/);
  });

  it("retrieves only matching project memories and supersedes stale facts", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1 });
    const pnpm = await store.save({
      scope: "PROJECT",
      projectId: "project-1",
      topic: "package manager",
      fact: "uses pnpm",
      confidence: 0.9,
      evidenceRefs: ["run-1"],
      sensitivity: "PUBLIC",
    });
    const bun = await store.save({
      scope: "PROJECT",
      projectId: "project-1",
      topic: "package manager",
      fact: "uses bun",
      confidence: 0.95,
      evidenceRefs: ["package.json"],
      sensitivity: "PUBLIC",
    });
    await store.supersede(pnpm.id, bun.id);
    const found = await new MemoryRetriever(store).retrieve({
      scope: "PROJECT",
      projectId: "project-1",
      goal: "what package manager should I use?",
      maxItems: 10,
    });
    expect(found.map((item) => item.fact)).toEqual(["uses bun"]);
    expect((await store.get(pnpm.id))?.status).toBe("SUPERSEDED");
  });

  it("respects the retrieval token budget", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1 });
    await store.save({
      scope: "PROJECT",
      projectId: "project-1",
      topic: "package manager",
      fact: "uses pnpm for the workspace",
      confidence: 0.9,
      evidenceRefs: ["run-1"],
      sensitivity: "PUBLIC",
    });
    await store.save({
      scope: "PROJECT",
      projectId: "project-1",
      topic: "package manager",
      fact: "uses npm for compatibility",
      confidence: 0.8,
      evidenceRefs: ["run-2"],
      sensitivity: "PUBLIC",
    });
    const found = await new MemoryRetriever(store).retrieve({
      scope: "PROJECT",
      projectId: "project-1",
      goal: "package manager",
      maxItems: 10,
      maxTokens: 12,
    });
    expect(found).toHaveLength(1);
  });
});
