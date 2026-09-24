import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function read(relativePath: string): Promise<string> {
  return await readFile(path.join(root, relativePath), "utf8");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

describe("Phase 5E transcript/client cutover", () => {
  it("freezes the Protocol Transcript DTO and public pagination contract", async () => {
    const transcript = await read("packages/protocol/src/api/transcript.ts");
    expect(transcript).toContain("TranscriptEntryBase");
    expect(transcript).toContain('kind: z.literal("USER")');
    expect(transcript).toContain('kind: z.literal("ASSISTANT")');
    expect(transcript).toContain('kind: z.literal("TOOL_RESULT")');
    expect(transcript).toContain('kind: z.literal("CUSTOM")');
    expect(transcript).toContain('kind: z.literal("RUN_TERMINAL")');
    expect(transcript).toContain("SessionTranscriptQuery");
    expect(transcript).toContain("SessionTranscriptResponse");
  });

  it("keeps transcript projection on the daemon/Agent side and out of the client package", async () => {
    const clientFiles = await sourceFiles("packages/client/src");
    const clientSource = (await Promise.all(clientFiles.map(read))).join("\n");
    expect(clientSource).toContain("getSessionTranscript");
    expect(clientSource).not.toContain("@caelush/agent");

    const service = await read("apps/daemon/src/services/session-transcript-service.ts");
    const route = await read("apps/daemon/src/routes/sessions.ts");
    expect(service).toContain("AgentMessageCodecRegistry");
    expect(service).toContain("unsupportedHistoricalTranscriptEntry");
    expect(service).not.toContain("JSON.stringify(record.data)");
    expect(route).toContain("/api/v1/sessions/:sessionId/transcript");
    expect(route).toContain("SessionTranscriptResponseSchema");
  });

  it("makes CLI and Web consume Protocol Transcript entries with explicit incompatibility handling", async () => {
    const cli = await read("apps/cli/src/application/cli-controller.ts");
    const web = await read("apps/web/src/application/session-manager.ts");
    expect(cli).toContain("getSessionTranscript");
    expect(web).toContain("getSessionTranscript");
    expect(cli).toContain("capabilities.sessionTranscript");
    expect(web).toContain("capabilities.sessionTranscript");
    expect(cli).not.toContain("hydrateSessionTranscript");
    expect(web).not.toContain("hydrateSessionTranscript");
    expect(cli).toContain("CaelushProtocolCompatibilityError");
    expect(web).toContain("CaelushProtocolCompatibilityError");
    expect(await read("apps/cli/src/application/cli-state.ts")).toContain("TranscriptEntry");
    expect(await read("apps/web/src/components/session-workspace.ts")).toContain("TranscriptEntry");
  });

  it("keeps AgentEvent Timeline projection separate from Transcript projection", async () => {
    const cliEventProjector = await read("apps/cli/src/application/event-projector.ts");
    const webManager = await read("apps/web/src/application/session-manager.ts");
    expect(cliEventProjector).toContain("AgentEvent");
    expect(webManager).toContain("AgentEvent");
    expect(cliEventProjector).not.toContain("TranscriptEntry");
  });

  it("proves Coding custom message extension by declaration merging, not core union editing", async () => {
    const coding = await read("packages/coding-agent/src/messages/command-execution.ts");
    const coreUnion = await read("packages/agent/src/messages/types/agent-message.ts");
    expect(coding).toContain('declare module "@caelush/agent"');
    expect(coding).toContain("CODING_COMMAND_EXECUTION");
    expect(coding).toContain("CODING_COMMAND_EXECUTION_MESSAGE_CODEC_V1");
    expect(coding).toContain("CODING_COMMAND_EXECUTION_MESSAGE_PROJECTOR_V1");
    expect(coding).toContain("CODING_COMMAND_EXECUTION_TRANSCRIPT_PROJECTOR");
    expect(coreUnion).not.toContain("CODING_COMMAND_EXECUTION");
  });

  it("records the completed 5F cutover and final storage shape", async () => {
    const documents = await Promise.all([
      read("README.md"),
      read("docs/ARCHITECTURE.md"),
      read("AGENTS.md"),
    ]);
    for (const document of documents) {
      expect(document).toContain("Phase 5E");
      expect(document).toContain("COMPLETE");
      expect(document).toContain("Phase 5F");
      expect(document).toContain("COMPLETE");
    }
    const schema = await read("packages/storage/src/schema.ts");
    const migration = await read(
      "packages/storage/drizzle/20260924120000_message_system_v2_final/migration.sql",
    );
    expect(schema).toContain("agent_messages");
    expect(schema).toContain("message_id");
    expect(schema).not.toContain("v2_data_json");
    expect(migration).toContain("CREATE TABLE `agent_messages__phase5f`");
    expect(migration).toContain("data_json");
  });
});
