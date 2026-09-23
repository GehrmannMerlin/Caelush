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

describe("Phase 5C durable conversation runtime cutover", () => {
  it("makes durable Run snapshots and appends record-native", async () => {
    const port = code(await read("packages/agent/src/run/ports/run-execution-store.ts"));
    expect(port).toContain("AgentMessageRecord");
    expect(port).toContain("AgentMessageRecordDraft");
    expect(port).toContain("readonly conversationRecords: readonly AgentMessageRecord[];");
    expect(port).toContain("readonly draft: AgentMessageRecordDraft;");
    expect(port).not.toContain("RunConversationEntry");
    expect(port).not.toContain("AIMessage");
  });

  it("keeps Storage raw-record-only at the Run execution boundary", async () => {
    const store = code(await read("packages/storage/src/run-execution-store.ts"));
    expect(store).toContain("SqliteAgentMessageRecordStore");
    expect(store).toContain("appendAgentMessageRecordsInTransaction");
    expect(store).not.toContain("toAgentAIMessage");
    expect(store).not.toContain("toLegacyDurableMessage");
    expect(store).not.toContain("SqliteConversationRepository");
  });

  it("makes the Tool feedback projection carry a durable receipt", async () => {
    const projector = code(
      await read("packages/agent/src/tools/observation/model-feedback-projector.ts"),
    );
    expect(projector).toContain("ProjectedToolFeedback");
    expect(projector).toContain("readonly receipt: ToolFeedbackProjectionReceipt;");
    expect(projector).toContain("project(input");
    expect(projector).toContain("toolFeedbackPolicySnapshot");
  });

  it("records the Phase 5C authority map and Phase 5D holdback", async () => {
    const map = await read(
      "docs/architecture/v2/PHASE_5C_DURABLE_CONVERSATION_RUNTIME_CUTOVER_ACCEPTANCE_MAP.md",
    );
    expect(map).toContain("AgentMessageRecord");
    expect(map).toContain("Factory -> Codec Registry -> `AgentMessageRecordDraft`");
    expect(map).toContain("Phase 5D");
  });
});
