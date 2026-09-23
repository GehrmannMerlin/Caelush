import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function read(relativePath: string): Promise<string> {
  return await readFile(path.join(root, relativePath), "utf8");
}

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("Phase 5D context and replay cutover", () => {
  it("makes the frozen Agent input reference the durable conversation", async () => {
    const types = code(await read("packages/agent/src/loop/types.ts"));
    expect(types).toContain("readonly conversation: AgentConversationSnapshot;");
    expect(types).not.toContain("readonly history: readonly AIMessage[];");
    expect(types).toContain("readonly userMessageId: AgentMessageId;");
    expect(types).toContain("readonly toolResultMessageIds: readonly AgentMessageId[];");
    expect(types).not.toContain("readonly messages: readonly AIUserMessage[];");
    expect(types).not.toContain("readonly results: readonly AIToolResultMessage[];");
  });

  it("makes Context receive a snapshot and keeps prepared output model-facing", async () => {
    const port = code(await read("packages/agent/src/loop/context/context-engine-port.ts"));
    const types = code(await read("packages/agent/src/loop/types.ts"));
    expect(port).toContain("readonly conversation: AgentConversationSnapshot;");
    expect(port).not.toContain("readonly history: readonly AIMessage[];");
    expect(port).toContain("PreparedModelContext");
    expect(types).toContain("readonly messages: readonly AIMessage[];");
  });

  it("passes the snapshot through the Run execution driver without an AI history field", async () => {
    const driver = code(await read("packages/agent/src/run/run-execution-driver.ts"));
    expect(driver).toContain("readonly conversation: AgentConversationSnapshot;");
    expect(driver).toContain("conversation: context.conversation");
    expect(driver).not.toContain("readonly history: readonly AIMessage[];");
    expect(driver).not.toContain("history: context.history");
  });

  it("uses the semantic conversation repository at the Core/daemon composition boundary", async () => {
    const authority = code(await read("packages/core/src/run-message-materializer.ts"));
    const controller = code(await read("packages/core/src/run-controller.ts"));
    const composition = code(await read("apps/daemon/src/daemon-composition.ts"));
    expect(authority).toContain("readonly conversation: AgentConversationRepository;");
    expect(controller).toContain("messages.conversation.loadSnapshot");
    expect(controller).not.toContain("projectRunAgentHistory({");
    expect(composition).toContain("createAgentConversationRepository");
    expect(composition).toContain("messageRecords");
  });

  it("keeps the legacy AI history projector as compatibility-only code", async () => {
    const history = await read("packages/core/src/run-agent-history.ts");
    const index = code(await read("packages/core/src/index.ts"));
    expect(history).toContain("COMPATIBILITY");
    expect(index).toContain("projectRunAgentHistory");
  });

  it("does not let the production Context adapter treat legacy history as durable authority", async () => {
    const adapter = code(await read("packages/core/src/legacy-context-runtime-adapter.ts"));
    expect(adapter).toContain("AgentConversationSnapshot");
    expect(adapter).toContain("createConversationSelector");
    expect(adapter).toContain("projectStoredMessages");
    expect(adapter).not.toContain("const history = input.history.map(toLegacyMessage)");
  });

  it("records the Phase 5D boundary without claiming the later transcript or retirement phases", async () => {
    const readme = await read("README.md");
    const architecture = await read("docs/ARCHITECTURE.md");
    const agents = await read("AGENTS.md");
    for (const text of [readme, architecture, agents]) {
      expect(text).toContain("Phase 5D");
      expect(text).toContain("Phase 5E");
      expect(text).toContain("Phase 5F");
    }
  });
});
