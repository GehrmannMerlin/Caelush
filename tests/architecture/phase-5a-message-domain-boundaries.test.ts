import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 5A — the Message Domain boundary guard.
 *
 * ```text
 * @caelush/ai                        the model protocol language
 *   AIMessage
 *     ├── AISystemMessage             Context-materializer only
 *     └── AIConversationMessage       user / assistant / tool
 *
 * @caelush/agent                     the conversation language
 *   AgentMessage
 *     ├── USER / ASSISTANT / TOOL_RESULT
 *     └── CustomAgentMessages         a declaration-merging seam, empty in 5A
 *
 *   StoredAgentMessage → saved projection version → projector registry → AIConversationMessage[]
 * ```
 *
 * ## What "retired" and "forbidden" mean here, precisely
 *
 * ```text
 * a dependency that must not exist      @caelush/ai -> @caelush/agent, agent -> coding-agent,
 *                                       storage, context, client, daemon
 * a declaration that must not exist      AgentSystemMessage, a SYSTEM arm, a second AI message
 *                                       implementation, a second JSON vocabulary
 * a member that must not exist           sequence on AgentMessageBase
 * a pattern that must not exist          provider-name branching, SQL, a migration
 * a cutover that must not have happened  RunExecutionStore, Context history, Client transcript
 * ```
 *
 * Historical Markdown under `docs/` is explicitly **not** in scope: the Phase 5A reports are
 * evidence of what the round did and must keep saying it. Only active source is guarded.
 */

const repositoryRoot = process.cwd();

function abs(...parts: readonly string[]): string {
  return path.join(repositoryRoot, ...parts);
}

async function read(relativePath: string): Promise<string> {
  return await readFile(abs(relativePath), "utf8");
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(abs(relativePath));
    return true;
  } catch {
    return false;
  }
}

/** Source with comments removed, so documentation about a forbidden pattern is not a violation. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** One source file, or `""` when it does not exist. Guards must assert absence, not throw. */
async function sourceOrEmpty(relativePath: string): Promise<string> {
  return (await exists(relativePath)) ? code(await read(relativePath)) : "";
}

/**
 * This guard's own path.
 *
 * Excluded from whole-workspace scans, because asserting "nothing may name the forbidden
 * package" requires *naming* it. A guard that fails on itself cannot guard anything.
 */
const SELF = "tests/architecture/phase-5a-message-domain-boundaries.test.ts";

/** Active source only: no build output, no dependencies, no historical Markdown, not this guard. */
async function activeSourceFiles(roots: readonly string[]): Promise<readonly string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    if (!(await exists(root))) continue;
    await collect(root, found);
  }
  found.delete(SELF);
  return [...found].sort();
}

async function collect(relativeDir: string, into: Set<string>): Promise<void> {
  for (const entry of await readdir(abs(relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      await collect(relative, into);
    } else if (/\.(?:ts|tsx|js|mjs|cjs|jsx)$/.test(entry.name)) {
      into.add(relative);
    }
  }
}

const MESSAGE_SOURCE = "packages/agent/src/messages";

/** Every production source file under the Message Domain. */
async function messageDomainFiles(): Promise<readonly string[]> {
  return await activeSourceFiles([MESSAGE_SOURCE]);
}

/** Every workspace manifest, so a dependency edge can be asserted absent. */
async function manifestPaths(): Promise<readonly string[]> {
  const found: string[] = ["package.json"];
  for (const group of ["packages", "apps"]) {
    if (!(await exists(group))) continue;
    for (const entry of await readdir(abs(group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = `${group}/${entry.name}/package.json`;
      if (await exists(manifest)) found.push(manifest);
    }
  }
  return found;
}

async function manifest(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(relativePath)) as Record<string, unknown>;
}

function dependencyNames(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.keys(value as Record<string, unknown>);
}

/**
 * Every production source file's comment-stripped text, read once.
 *
 * Several assertions below scan all of `packages` and `apps`, and this suite runs beside the whole
 * workspace's test run. Reading a few hundred files concurrently and once — rather than
 * sequentially and once per assertion — is what keeps a whole-repository guard inside the default
 * test timeout. It is the same caching discipline the Phase 4F guard uses, and it matters more here
 * because this guard has many declaration assertions rather than one.
 */
let sourceCache: Map<string, string> | undefined;

async function executableSources(): Promise<Map<string, string>> {
  if (sourceCache === undefined) {
    const files = (await activeSourceFiles(["packages", "apps"])).filter(
      (file) => !file.includes("/test/"),
    );
    const entries = await Promise.all(
      files.map(async (file) => [file, code(await read(file))] as const),
    );
    sourceCache = new Map(entries);
  }
  return sourceCache;
}

/** A declaration holder: a production file whose text contains the declaration. */
async function declarationHolders(declaration: string): Promise<readonly string[]> {
  const holders: string[] = [];
  for (const [file, text] of await executableSources()) {
    if (text.includes(declaration)) holders.push(file);
  }
  return holders.sort();
}

/* ------------------------------------------------------------------ the frozen export list */

const REQUIRED_AGENT_MESSAGE_EXPORTS = [
  "AgentMessageId",
  "ConversationTurnId",
  "ConversationTurnIdFactory",
  "AgentMessageAudience",
  "AgentMessageSource",
  "AgentMessageBase",
  "AgentTextPart",
  "AgentAttachmentRefPart",
  "AgentUserContentPart",
  "AgentUserMessage",
  "AgentAssistantTextPart",
  "AgentAssistantToolCallPart",
  "AgentAssistantContentPart",
  "AgentAssistantModelProvenance",
  "AgentAssistantMessage",
  "ToolFeedbackProjectionReceipt",
  "AgentToolResultMessage",
  "CustomAgentMessages",
  "AgentMessage",
  "AgentMessageSchemaVersion",
  "AgentMessageProjectionVersion",
  "AgentMessageRecord",
  "StoredAgentMessage",
  "AgentMessageDraft",
  "AgentMessageRecordDraft",
  "AgentMessageCodec",
  "AgentMessageCodecRegistry",
  "AgentMessageCodecRegistryBuilder",
  "AgentMessageAIProjection",
  "AgentMessageProjector",
  "AgentMessageProjectorRegistry",
  "AgentMessageProjectionError",
  "OpaqueAgentMessageRecord",
  "ConversationTurnStatus",
  "ConversationTurn",
  "AgentConversationSnapshot",
  "AgentConversationValidator",
  "ExecutionUnit",
  "ConversationSelector",
  "SelectedAgentConversation",
] as const;

const REQUIRED_AI_MESSAGE_EXPORTS = [
  "AIProviderOpaqueState",
  "AITextContent",
  "AIToolCallContent",
  "AIConversationMessage",
  "AIMessage",
  "AISystemMessage",
  "AIUserMessage",
  "AIAssistantMessage",
  "AIToolResultMessage",
  "AIAssistantTextContent",
  "AIAssistantToolCallContent",
  "AIAssistantContent",
] as const;

describe("Phase 5A guard — root-only public surface (freeze §128, §129, §130)", () => {
  it("exports every frozen Agent Message Domain name from the package root", async () => {
    const agentIndex = code(await read("packages/agent/src/index.ts"));
    for (const name of REQUIRED_AGENT_MESSAGE_EXPORTS) {
      expect(agentIndex, name).toContain(name);
    }
  });

  it("exports every frozen AI message name, old and new, from the package root", async () => {
    const aiIndex = code(await read("packages/ai/src/index.ts"));
    for (const name of REQUIRED_AI_MESSAGE_EXPORTS) {
      expect(aiIndex, name).toContain(name);
    }
  });

  it("requires no deep import for any Message Domain consumer", async () => {
    // The public surface is root-only. A consumer that had to reach into
    // `@caelush/agent/src/messages/...` would be depending on a private layout.
    const offenders: string[] = [];
    for (const file of await activeSourceFiles(["packages", "apps"])) {
      if (file.startsWith(MESSAGE_SOURCE)) continue;
      const text = code(await read(file));
      if (text.includes("@caelush/agent/src/messages")) offenders.push(file);
      if (text.includes("@caelush/agent/dist/messages")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("does not re-export another workspace package from the agent root", async () => {
    const agentIndex = code(await read("packages/agent/src/index.ts"));
    expect(agentIndex).not.toMatch(/^\s*export\s+\*\s+from\s+"@caelush\//m);
  });
});

describe("Phase 5A guard — package boundaries (freeze §150, §151)", () => {
  it("keeps @caelush/ai free of any @caelush/agent dependency", async () => {
    const aiManifest = await manifest("packages/ai/package.json");
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      expect(dependencyNames(aiManifest[field]), field).not.toContain("@caelush/agent");
    }
    // And the AI package declares no workspace dependency of any kind: it is an independent
    // root, which is why it owns its own `ModelRef`, `LLMCallId` and `JsonObject`.
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const name of dependencyNames(aiManifest[field])) {
        expect(name.startsWith("@caelush/"), `${field}: ${name}`).toBe(false);
      }
    }
  });

  it("keeps @caelush/agent free of every forbidden workspace dependency", async () => {
    const agentManifest = await manifest("packages/agent/package.json");
    const declared = [
      ...dependencyNames(agentManifest["dependencies"]),
      ...dependencyNames(agentManifest["devDependencies"]),
      ...dependencyNames(agentManifest["peerDependencies"]),
      ...dependencyNames(agentManifest["optionalDependencies"]),
    ];
    for (const forbidden of [
      "@caelush/coding-agent",
      "@caelush/storage",
      "@caelush/context",
      "@caelush/client",
      "@caelush/core",
      "@caelush/llm",
      "@caelush/runtime",
      "@caelush/security",
      "@caelush/verification",
      "@caelush/events",
      "@caelush/memory",
      "@caelush/shared",
      "@caelush/observability",
      "@caelush/tools",
    ]) {
      expect(declared, forbidden).not.toContain(forbidden);
    }
    // The permitted edges are exactly the AI contract, Protocol and the schema runtime.
    for (const name of declared) {
      if (!name.startsWith("@caelush/")) continue;
      expect(["@caelush/ai", "@caelush/protocol"], name).toContain(name);
    }
  });

  it("imports no forbidden package from the Message Domain source", async () => {
    for (const file of await messageDomainFiles()) {
      const text = code(await read(file));
      for (const specifier of text.matchAll(/from\s+"([^"]+)"/g)) {
        const target = specifier[1] ?? "";
        if (!target.startsWith("@caelush/")) continue;
        // Root specifiers only: a deep import into another package is also forbidden, and the
        // workspace checker reports it as a private import.
        expect(["@caelush/ai", "@caelush/protocol"], `${file}: ${target}`).toContain(target);
      }
    }
  });

  it("keeps the daemon and the Client out of the Message Domain", async () => {
    for (const file of await messageDomainFiles()) {
      const text = code(await read(file));
      for (const forbidden of [
        "apps/daemon",
        "@caelush/client",
        "@caelush/storage",
        "@caelush/context",
        "@caelush/coding-agent",
      ]) {
        expect(text, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the Message Domain out of every consumer that must not need it yet", async () => {
    // Phase 5D activates the semantic conversation cutover. The allowlist remains closed: only the
    // explicit production composition, Agent execution snapshot path, Context compatibility adapter,
    // and raw V2 store paths may consume Message Domain records.
    const allowedConsumers = [
      // The V2 record store and its legacy compatibility reader — the port implementations.
      "packages/storage/src/messages/sqlite-agent-message-record-store.ts",
      "packages/storage/src/messages/legacy/legacy-llm-message-codec.ts",
      "packages/storage/src/messages/legacy/dual-reader.ts",
      "packages/storage/src/messages/legacy/backfill.ts",
      // The package barrel that publishes them, and the facade that exposes the V2 store beside
      // the pre-V2 compatibility reader.
      "packages/storage/src/index.ts",
      "packages/storage/src/storage.ts",
      "apps/daemon/src/daemon-composition.ts",
      "apps/daemon/src/services/session-conversation-context.ts",
      "apps/daemon/src/services/session-transcript-service.ts",
      "packages/agent/src/run/ports/run-execution-store.ts",
      "packages/core/src/run-agent-history.ts",
      "packages/core/src/run-message-materializer.ts",
      "packages/core/src/legacy-agent-conversation.ts",
      "packages/core/src/legacy-context-runtime-adapter.ts",
      "packages/storage/src/run-execution-store.ts",
      "packages/agent/src/loop/context/context-engine-port.ts",
      "packages/agent/src/loop/types.ts",
      // Phase 7A freezes ContextSourceInput with the durable conversation snapshot as semantic input.
      "packages/agent/src/context/source/context-source.ts",
      // Phase 7B consumes the Message Domain only through the canonical semantic history seam.
      "packages/agent/src/context/history/semantic-history-unit.ts",
      "packages/agent/src/context/planner/context-planner.ts",
      "packages/agent/src/run/run-execution-driver.ts",
      // Phase 7D extends the same pure Agent Context target path with deterministic compaction
      // contracts and the provider-neutral materializer. These are still Agent-owned contracts,
      // not a new consumer-owned Message Domain implementation.
      "packages/agent/src/context/compaction/context-compaction-contracts.ts",
      "packages/agent/src/context/materializer/context-materializer.ts",
    ];
    const consumers: string[] = [];
    for (const file of await activeSourceFiles(["packages", "apps"])) {
      if (file.startsWith(MESSAGE_SOURCE)) continue;
      if (file === "packages/agent/src/index.ts") continue;
      if (file.includes("/test/")) continue;
      if (allowedConsumers.includes(file)) continue;
      const text = code(await read(file));
      for (const name of [
        "AgentMessageRecord",
        "ConversationTurnId",
        "AgentConversationSnapshot",
        "AgentConversationValidator",
        "AgentMessageProjectorRegistry",
      ]) {
        if (text.includes(name)) consumers.push(`${file}: ${name}`);
      }
    }
    expect(consumers).toEqual([]);
  });
});

describe("Phase 5A guard — no system message can exist in the Agent language (freeze §153)", () => {
  it("declares no AgentSystemMessage anywhere in production source", async () => {
    expect(await declarationHolders("AgentSystemMessage")).toEqual([]);
  });

  it("has no SYSTEM arm in the Agent message union", async () => {
    const union = code(await read("packages/agent/src/messages/types/agent-message.ts"));
    expect(union).not.toContain('"SYSTEM"');
    expect(union).not.toContain("AgentSystemMessage");
    // The three canonical discriminants are exactly what the union names.
    for (const type of ["USER", "ASSISTANT", "TOOL_RESULT"]) {
      expect(union, type).toContain(type);
    }
  });

  it("declares the union exactly once", async () => {
    expect(await declarationHolders("export type AgentMessage =")).toEqual([
      "packages/agent/src/messages/types/agent-message.ts",
    ]);
  });

  it("keeps the AI conversation union free of a system arm", async () => {
    const messageModule = code(await read("packages/ai/src/messages/message.ts"));
    expect(messageModule).toContain(
      "export type AIConversationMessage = AIUserMessage | AIAssistantMessage | AIToolResultMessage;",
    );
    expect(messageModule).toContain(
      "export type AIMessage = AISystemMessage | AIConversationMessage;",
    );
  });

  it("returns AIConversationMessage from a projector, never AIMessage", async () => {
    const projector = code(await read("packages/agent/src/messages/projection/projector.ts"));
    expect(projector).toContain("readonly messages: readonly AIConversationMessage[];");
    expect(projector).not.toContain("readonly messages: readonly AIMessage[];");
  });
});

describe("Phase 5A guard — storage-assigned ordering only (freeze §154, §155)", () => {
  it("keeps AgentMessageBase free of a sequence member", async () => {
    const base = code(await read("packages/agent/src/messages/types/message-base.ts"));
    // The frozen contract's whole point: a semantic message does not know its own position.
    expect(base).not.toMatch(/\bsequence\b\s*:/);
    expect(base).not.toContain("sequence?");
    // And the eight frozen members are present.
    for (const member of [
      "id",
      "runId",
      "sessionId",
      "conversationTurnId",
      "createdAt",
      "sourceStepId",
      "source",
      "audience",
    ]) {
      expect(base, member).toContain(member);
    }
  });

  it("declares sequence only on the record, the stored message and the unit range", async () => {
    // `sequence` is a legitimate word elsewhere in the repository — durable event ordering, Step
    // ordering, Client timeline ordering — so the guard is stated against the *Message Domain's*
    // semantic types, which are the ones the freeze forbids it on.
    for (const forbidden of [
      "packages/agent/src/messages/types/message-base.ts",
      "packages/agent/src/messages/types/user-message.ts",
      "packages/agent/src/messages/types/assistant-message.ts",
      "packages/agent/src/messages/types/tool-result-message.ts",
      "packages/agent/src/messages/types/agent-message.ts",
      "packages/agent/src/messages/types/content.ts",
      "packages/agent/src/messages/types/source.ts",
      "packages/agent/src/messages/types/audience.ts",
      "packages/agent/src/messages/types/custom-agent-messages.ts",
    ]) {
      const text = code(await read(forbidden));
      expect(text, forbidden).not.toContain("sequence");
    }
  });

  it("declares sequence on the durable envelope and the unit range", async () => {
    // The positive half: the places it *does* belong, each of which is storage-assigned.
    const record = code(await read("packages/agent/src/messages/persistence/record.ts"));
    expect(record).toContain("readonly sequence: number;");
    const unit = code(await read("packages/agent/src/messages/conversation/execution-unit.ts"));
    expect(unit).toContain("readonly sourceSequenceFrom: number;");
    expect(unit).toContain("readonly sourceSequenceTo: number;");
  });

  it("keeps a draft free of both sequence and runId", async () => {
    const record = code(await read("packages/agent/src/messages/persistence/record.ts"));
    const draftSection = record.slice(record.indexOf("export interface AgentMessageRecordDraft"));
    const draftBody = draftSection.slice(0, draftSection.indexOf("}"));
    expect(draftBody).not.toContain("sequence");
    expect(draftBody).not.toContain("runId");
  });

  it("keeps a message draft free of sequence", async () => {
    const record = code(await read("packages/agent/src/messages/persistence/record.ts"));
    const draftSection = record.slice(
      record.indexOf("export interface AgentMessageDraft"),
      record.indexOf("export interface AgentMessageRecordDraft"),
    );
    expect(draftSection).not.toContain("sequence");
    // It does carry both versions, which is what `encode` produces.
    expect(draftSection).toContain("schemaVersion");
    expect(draftSection).toContain("modelProjectionVersion");
  });
});

describe("Phase 5A guard — no provider branching and no Provider SDK (freeze §144, §152, §156)", () => {
  const PROVIDER_NAMES = [
    "openai",
    "anthropic",
    "deepseek",
    "google",
    "gemini",
    "bedrock",
    "mistral",
    "cohere",
  ] as const;

  it("names no provider anywhere in the Message Domain", async () => {
    for (const file of await messageDomainFiles()) {
      const text = (await read(file)).toLowerCase();
      for (const provider of PROVIDER_NAMES) {
        expect(text, `${file}: ${provider}`).not.toContain(provider);
      }
    }
  });

  it("imports no provider adapter or SDK from the projection directory", async () => {
    for (const file of await activeSourceFiles([`${MESSAGE_SOURCE}/projection`])) {
      const text = code(await read(file));
      for (const forbidden of [
        "adapters/",
        "@ai-sdk/",
        "openai",
        "anthropic",
        "provider-registry",
        "api-adapter",
      ]) {
        expect(text, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("does not import the provider adapter surface from anywhere in the Message Domain", async () => {
    for (const file of await messageDomainFiles()) {
      const text = code(await read(file));
      for (const specifier of text.matchAll(/from\s+"([^"]+)"/g)) {
        const target = specifier[1] ?? "";
        expect(target, `${file}: ${target}`).not.toContain("adapters");
        expect(target, `${file}: ${target}`).not.toContain("provider");
      }
    }
  });

  it("reads no payload out of provider opaque state", async () => {
    // The state is stored, validated and handed on. Nothing in the Message Domain may index
    // into it, because a layer that understood the payload would be a layer that could
    // disagree with the provider about what it means.
    for (const file of await messageDomainFiles()) {
      const text = code(await read(file));
      expect(text, file).not.toMatch(/providerState\s*\.\s*payload\s*[[.]/);
      expect(text, file).not.toMatch(/payload\s*\[\s*["']/);
    }
  });
});

describe("Phase 5A guard — no persistence implementation (freeze §157, §164)", () => {
  it("contains no SQL, no sqlite and no migration in the Message Domain", async () => {
    for (const file of await messageDomainFiles()) {
      const text = code(await read(file)).toLowerCase();
      // Strong, unambiguous storage indicators only. A generic word like "database" or
      // "migration" appears in ordinary prose about what this layer does *not* own — including
      // in the refusal message that says legacy provenance belongs to migration — and a guard
      // that fired on prose would be a guard nobody could keep passing for the right reason.
      // The migration-specific rules below are stated concretely instead.
      for (const forbidden of [
        "sqlite",
        "better-sqlite3",
        "drizzle",
        "begin immediate",
        "insert into",
        "create table",
        "create index",
        "agent_messages",
        "schema_version integer",
        "conversation_turns",
      ]) {
        expect(text, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("imports no filesystem or database module in the Message Domain", async () => {
    for (const file of await messageDomainFiles()) {
      const text = code(await read(file));
      for (const forbidden of [
        "node:fs",
        "node:sqlite",
        "node:child_process",
        "node:net",
        "node:http",
        "node:https",
      ]) {
        expect(text, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("declares no store port, repository or SQLite schema", async () => {
    // Phase 5A declared no persistence contract at all. Phase 5B added the two Agent-owned ports — that
    // is the whole point of the storage round — so the rule now names what must still be absent: a
    // Storage-side declaration of either port, and any SQLite table object for messages.
    for (const declaration of ["SqliteAgentMessageRepository", "agentMessagesTable"]) {
      expect(await declarationHolders(declaration), declaration).toEqual([]);
    }
    // The ports are declared once each, and in the Agent package. Storage implements them.
    for (const declaration of [
      "export interface AgentMessageRecordStorePort {",
      "export interface AgentConversationRepository {",
    ]) {
      const holders = await declarationHolders(declaration);
      expect(holders.length, declaration).toBe(1);
      expect(holders[0], declaration).toContain("packages/agent/src/messages/");
    }
  });

  it("creates no conversation_turns table or schema (freeze §27)", async () => {
    expect(await declarationHolders("conversation_turns")).toEqual([]);
    const migrations = await activeSourceFiles(["packages/storage/src"]);
    for (const file of migrations) {
      expect(code(await read(file)), file).not.toContain("conversation_turns");
    }
  });

  it("adds no storage migration in this round", async () => {
    // The migration set is exactly what Phase 4 left. A new migration file would be 5B work.
    const migrationFiles: string[] = [];
    for (const file of await activeSourceFiles(["packages/storage/src"])) {
      if (/migration/i.test(file)) migrationFiles.push(file);
    }
    // Nothing in this round claimed a migration path, so the set is only what already existed
    // and no file under it was added by the Message Domain.
    for (const file of migrationFiles) {
      expect(code(await read(file)), file).not.toContain("AgentMessageRecord");
    }
  });
});

describe("Phase 5A guard — retained foundations after the Phase 5D cutover", () => {
  it("keeps the RunExecutionStore message shape unchanged", async () => {
    const store = code(await read("packages/agent/src/run/ports/run-execution-store.ts"));
    // Phase 5C is the deliberate cutover point: the execution contract carries raw V2 records and
    // encoded drafts; AIMessage remains only on the temporary projection seam.
    expect(store).toContain("readonly conversationRecords: readonly AgentMessageRecord[];");
    expect(store).toContain("readonly draft: AgentMessageRecordDraft;");
    expect(store).not.toContain("RunConversationEntry");
  });

  it("moves AgentLoopAdvanceInput to the Phase 5D conversation snapshot", async () => {
    const types = code(await read("packages/agent/src/loop/types.ts"));
    expect(types).toContain("readonly conversation: AgentConversationSnapshot;");
    expect(types).toContain("AgentMessageId");
    expect(types).not.toContain("readonly history: readonly AIMessage[];");
  });

  it("moves ContextPrepareInput to the Phase 5D conversation snapshot", async () => {
    const port = code(await read("packages/agent/src/loop/context/context-engine-port.ts"));
    expect(port).toContain("readonly conversation: AgentConversationSnapshot;");
    expect(port).not.toContain("readonly history: readonly AIMessage[];");
  });

  it("keeps the legacy AI history validator present and unextended (freeze §161)", async () => {
    const history = code(await read("packages/agent/src/loop/history/conversation-history.ts"));
    expect(history).toContain("export function assertConversationProtocolIntegrity");
    expect(history).toContain("export function assertPendingAssistantHistory");
    expect(history).toContain("export function assertAgentTurnInput");
    // It must not have grown any Message System V2 concept: a rule added here would live in
    // the compatibility layer and never reach the target.
    for (const newConcept of [
      "AgentMessage",
      "ConversationTurn",
      "ExecutionUnit",
      "AgentConversationSnapshot",
      "modelProjectionVersion",
    ]) {
      expect(history, newConcept).not.toContain(newConcept);
    }
  });

  it("keeps the final Message V2 schema and record store as the only storage path", async () => {
    const schema = code(await read("packages/storage/src/schema.ts"));
    const store = code(
      await read("packages/storage/src/messages/sqlite-agent-message-record-store.ts"),
    );
    expect(schema).toContain('messageId: text("message_id").primaryKey()');
    expect(schema).toContain("modelProjectionVersion");
    expect(schema).toContain('dataJson: text("data_json").notNull()');
    expect(schema).not.toContain("v2_data_json");
    expect(store).toContain("appendAgentMessageRecordsInTransaction");
    expect(store).not.toContain("conversation-repository");
    expect(await exists("packages/storage/src/repositories/conversation-repository.ts")).toBe(
      false,
    );
    expect(await exists("packages/storage/src/messages/legacy/dual-reader.ts")).toBe(false);
  });

  it("keeps the Context execution unit on the canonical AI message contract", async () => {
    const contextUnit = code(await read("packages/context/src/execution-unit.ts"));
    expect(contextUnit).toContain("AIMessage");
    expect(contextUnit).toContain('from "@caelush/ai"');
    expect(contextUnit).not.toContain("LLMMessage");
    expect(contextUnit).not.toContain("AgentMessageId");
    expect(contextUnit).not.toContain("conversationTurnId");
  });

  it("keeps the Context TokenEstimator where it lives", async () => {
    const estimator = code(await read("packages/context/src/token-estimator.ts"));
    expect(estimator).toContain("export interface TokenEstimator");
    expect(estimator).toContain("estimateText(text: string): number;");
    // The Agent Domain declares its own narrow port and does not restate the heuristic.
    const agentEstimator = code(
      await read("packages/agent/src/messages/conversation/token-estimator.ts"),
    );
    expect(agentEstimator).toContain("estimateMessages(");
    expect(agentEstimator).not.toContain("Utf8HeuristicTokenEstimator");
  });

  it("keeps Client transcript loading on the canonical capability", async () => {
    const candidates = await activeSourceFiles(["packages/client/src"]);
    for (const file of candidates) {
      const text = code(await read(file));
      expect(text, file).not.toContain("hydrateSessionTranscript");
    }
    const client = code(await read("packages/client/src/client.ts"));
    expect(client).toContain("getSessionTranscript");
  });

  it("keeps Coding custom messages in the product extension seam (Phase 5E)", async () => {
    expect(await declarationHolders("CodingCommandExecutionMessage")).toEqual([
      "packages/coding-agent/src/index.ts",
      "packages/coding-agent/src/messages/command-execution.ts",
    ]);
    expect(await declarationHolders("CustomAgentMessages {")).toEqual([
      "packages/agent/src/messages/types/custom-agent-messages.ts",
      "packages/coding-agent/src/messages/command-execution.ts",
    ]);
    // The general seam stays empty; the Coding layer contributes its arm by module augmentation.
    const seam = code(await read("packages/agent/src/messages/types/custom-agent-messages.ts"));
    expect(seam).toMatch(/export interface CustomAgentMessages \{\}/);
  });
});

describe("Phase 5A guard — one authority per responsibility", () => {
  it("declares each frozen Message Domain contract exactly once", async () => {
    const declarations: readonly (readonly [string, string])[] = [
      ["export interface AgentMessageAudience {", "packages/agent/src/messages/types/audience.ts"],
      ["export type AgentMessageSource =", "packages/agent/src/messages/types/source.ts"],
      ["export interface AgentMessageBase {", "packages/agent/src/messages/types/message-base.ts"],
      ["export interface AgentUserMessage", "packages/agent/src/messages/types/user-message.ts"],
      [
        "export interface AgentAssistantMessage",
        "packages/agent/src/messages/types/assistant-message.ts",
      ],
      [
        "export interface AgentToolResultMessage",
        "packages/agent/src/messages/types/tool-result-message.ts",
      ],
      [
        "export interface ToolFeedbackProjectionReceipt {",
        "packages/agent/src/messages/types/tool-result-message.ts",
      ],
      [
        "export interface AgentMessageFactory {",
        "packages/agent/src/messages/types/message-factory.ts",
      ],
      [
        "export interface AgentMessageRecord {",
        "packages/agent/src/messages/persistence/record.ts",
      ],
      ["export interface StoredAgentMessage<", "packages/agent/src/messages/persistence/record.ts"],
      [
        "export interface AgentMessageCodecRegistry {",
        "packages/agent/src/messages/codec/registry.ts",
      ],
      [
        "export interface AgentMessageCodecRegistryBuilder {",
        "packages/agent/src/messages/codec/registry.ts",
      ],
      [
        "export interface AgentMessageProjectorRegistry {",
        "packages/agent/src/messages/projection/registry.ts",
      ],
      [
        "export interface AgentConversationSnapshot {",
        "packages/agent/src/messages/conversation/conversation-snapshot.ts",
      ],
      [
        "export interface AgentConversationValidator {",
        "packages/agent/src/messages/conversation/validator.ts",
      ],
      [
        "export interface ConversationTurn {",
        "packages/agent/src/messages/conversation/conversation-turn.ts",
      ],
      // `ExecutionUnit` is deliberately absent from this list: two of them exist during the
      // migration, and the next test states that boundary explicitly rather than pretending to
      // a singularity that does not hold yet.
      [
        "export interface ConversationSelector {",
        "packages/agent/src/messages/conversation/selector.ts",
      ],
      [
        "export interface SelectedAgentConversation {",
        "packages/agent/src/messages/conversation/selector.ts",
      ],
      // `TokenEstimator` is deliberately absent from this list: the Agent Domain declares its
      // own narrow port while `@caelush/context` keeps the algorithm, and the boundary has its
      // own test below.
    ];

    for (const [declaration, expectedFile] of declarations) {
      expect(await declarationHolders(declaration), declaration).toEqual([expectedFile]);
    }
  });

  it("keeps the Agent Domain's TokenEstimator a port, with the algorithm in @caelush/context", async () => {
    // The freeze forbids `agent -> context`, so the two are separate declarations with
    // different shapes: the Agent port takes projected AI messages, the Context one takes text.
    const holders = await declarationHolders("export interface TokenEstimator {");
    expect(holders).toEqual([
      "packages/agent/src/messages/conversation/token-estimator.ts",
      "packages/context/src/token-estimator.ts",
    ]);

    const file = await read("packages/agent/src/messages/conversation/token-estimator.ts");
    // The documentation is the contract statement here, so it is checked with comments intact.
    // A production host injects the Context implementation; the Agent default is a floor.
    expect(file).toMatch(/A production\s+\*\s+host injects the Context implementation\./);
    expect(file).toMatch(/a floor that keeps a\s+\*\s+misconfigured composition root/);

    const port = code(file);
    // The port speaks projected AI, so an implementation cannot accidentally count a durable
    // envelope the model never receives.
    expect(port).toContain("estimateMessages(messages: readonly AIConversationMessage[]): number;");
    expect(port).not.toContain("estimateText");
    // The Agent default carries no per-Tool behaviour, which is what makes it a floor rather
    // than a second copy of the Context algorithm.
    for (const toolSpecific of [
      "read_file",
      "exec_command",
      "apply_patch",
      "search_text",
      "truncat",
    ]) {
      expect(port, toolSpecific).not.toContain(toolSpecific);
    }
    expect(port).toContain("STRUCTURAL_TOKEN_ESTIMATOR");
    // The port declares exactly one method, so a host cannot be asked for a second estimate it
    // was never given a contract for.
    const portBody = port.slice(
      port.indexOf("export interface TokenEstimator {"),
      port.indexOf("}", port.indexOf("export interface TokenEstimator {")),
    );
    expect([...portBody.matchAll(/^\s{2}\w+\(/gm)]).toHaveLength(1);

    const concrete = code(await read("packages/context/src/token-estimator.ts"));
    expect(concrete).toContain("export class Utf8HeuristicTokenEstimator");
    expect(concrete).toContain("estimateText(text: string): number;");
  });

  it("keeps the Agent Message Domain's ExecutionUnit the only one in @caelush/agent", async () => {
    // Two `ExecutionUnit` types remain for the Agent domain and Context selection mechanics:
    //
    //   packages/agent/src/messages/conversation/execution-unit.ts   the Agent Message Domain
    //   packages/context/src/execution-unit.ts                       the AIMessage-based one
    //
    // `@caelush/agent` may contain only the first, and the second must stay outside the domain
    // so `agent -X-> context` remains true.
    const holders = await declarationHolders("export interface ExecutionUnit {");
    expect(holders).toEqual([
      "packages/agent/src/messages/conversation/execution-unit.ts",
      "packages/context/src/execution-unit.ts",
    ]);
    expect(holders.filter((holder) => holder.startsWith("packages/agent/"))).toHaveLength(1);
    // The Context one uses canonical AI messages and local source positions only for compaction.
    const legacy = code(await read("packages/context/src/execution-unit.ts"));
    expect(legacy).toContain("AIMessage");
    expect(legacy).toContain(":execution:${index}");
    // The Agent one derives identity from the durable message, never from a position.
    const domain = code(await read("packages/agent/src/messages/conversation/execution-unit.ts"));
    expect(domain).toContain("assistantMessageId");
    expect(domain).not.toContain("LLMMessage");
  });

  it("declares the AI provider opaque state exactly once", async () => {
    expect(await declarationHolders("export interface AIProviderOpaqueState {")).toEqual([
      "packages/ai/src/messages/provider-state.ts",
    ]);
  });

  it("declares each canonical AI content shape exactly once", async () => {
    expect(await declarationHolders("export interface AITextContent {")).toEqual([
      "packages/ai/src/messages/content.ts",
    ]);
    expect(await declarationHolders("export interface AIToolCallContent {")).toEqual([
      "packages/ai/src/messages/content.ts",
    ]);
  });

  it("keeps the compatibility names as aliases, not as second interfaces", async () => {
    const content = code(await read("packages/ai/src/messages/content.ts"));
    expect(content).toContain("export type AIAssistantTextContent = AITextContent;");
    expect(content).toContain("export type AIAssistantToolCallContent = AIToolCallContent;");
    expect(content).toContain("export type AIAssistantContent = AIContent;");
    // No second interface for either name.
    expect(content).not.toMatch(/export interface AIAssistantTextContent/);
    expect(content).not.toMatch(/export interface AIAssistantToolCallContent/);
  });

  it("keeps exactly one recursive JSON vocabulary in the AI package", async () => {
    // The Freeze requires an existing equivalent primitive to be reused, so a *second*
    // recursive JSON declaration inside `@caelush/ai` is a violation — and so is introducing
    // the frozen `AIJson*` names as aliases, which would give one shape two names.
    //
    // The scan is scoped to the AI package on purpose: Protocol owns its own wire JSON contract
    // and must keep it, because `@caelush/ai` may not depend on `@caelush/protocol`.
    const aiFiles = (await activeSourceFiles(["packages/ai/src"])).filter(
      (file) => !file.includes("/test/"),
    );
    const jsonHolders: string[] = [];
    const aliasHolders: string[] = [];
    for (const file of aiFiles) {
      const text = code(await read(file));
      if (
        text.includes("export interface JsonObject {") ||
        text.includes("export type JsonValue =")
      ) {
        jsonHolders.push(file);
      }
      if (/export (?:type|interface) AIJson/.test(text)) aliasHolders.push(file);
    }
    expect(jsonHolders).toEqual(["packages/ai/src/json/json-value.ts"]);
    expect(aliasHolders).toEqual([]);
    // And no deep JSON path was introduced: the vocabulary is reachable from the root.
    const aiIndex = code(await read("packages/ai/src/index.ts"));
    expect(aiIndex).toContain("JsonObject");
    expect(aiIndex).toContain("JsonValue");
  });

  it("declares no message-local provenance trio", async () => {
    for (const forbidden of [
      "MessageModelRef",
      "MessageFinishReason",
      "MessageUsage",
      "AgentMessageUsage",
      "AgentFinishReason",
    ]) {
      expect(await declarationHolders(forbidden), forbidden).toEqual([]);
    }
  });

  it("declares no second tool observation policy snapshot", async () => {
    expect(await declarationHolders("export interface ToolObservationPolicySnapshot {")).toEqual([
      "packages/agent/src/loop/types.ts",
    ]);
  });

  it("declares each Message Domain factory exactly once", async () => {
    for (const factory of [
      "export function createAgentMessageFactory(",
      "export function createAgentMessageCodecRegistry(",
      "export function createAgentMessageProjectorRegistry(",
      "export function createAgentConversationValidator(",
      "export function createConversationSelector(",
      "export function createDeterministicConversationTurnIdFactory(",
    ]) {
      const holders = await declarationHolders(factory);
      expect(holders.length, factory).toBe(1);
      expect(holders[0], factory).toContain(MESSAGE_SOURCE);
    }
  });

  it("keeps the projection error surface closed at four codes (freeze §97)", async () => {
    const errors = code(await read("packages/agent/src/messages/projection/errors.ts"));
    expect(errors).toContain("AGENT_MESSAGE_PROJECTION_ERROR_CODES");
    for (const code of [
      "UNKNOWN_MODEL_VISIBLE_MESSAGE",
      "PROJECTION_VERSION_UNAVAILABLE",
      "PROJECTION_FINGERPRINT_MISMATCH",
      "INVALID_PROJECTED_CONVERSATION",
    ]) {
      expect(errors, code).toContain(code);
    }
    // Exactly four members in the frozen list.
    const list = errors.slice(
      errors.indexOf("AGENT_MESSAGE_PROJECTION_ERROR_CODES = ["),
      errors.indexOf("] as const", errors.indexOf("AGENT_MESSAGE_PROJECTION_ERROR_CODES = [")),
    );
    expect([...list.matchAll(/"[A-Z_]+"/g)]).toHaveLength(4);
  });
});

describe("Phase 5A guard — the Message Domain is pure", () => {
  it("contains no clock read, no randomness and no environment access", async () => {
    for (const file of await messageDomainFiles()) {
      // The id module legitimately mints a new identity and reads the clock for a *new*
      // message id; that is its whole contract, and it is the only exception.
      if (file.endsWith("messages/types/ids.ts")) continue;
      const text = code(await read(file));
      for (const forbidden of [
        "Date.now(",
        "new Date(",
        "Math.random(",
        "randomUUID",
        "randomBytes",
        "process.env",
        "performance.now(",
      ]) {
        expect(text, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the conversation turn derivation clock-free", async () => {
    const ids = code(await read("packages/agent/src/messages/types/ids.ts"));
    // The turn derivation must not consult a clock: a timestamp would either break
    // determinism or become a constant shared by every turn of a Session.
    const derivation = ids.slice(
      ids.indexOf("function deriveConversationTurnId"),
      ids.indexOf("export function createAgentMessageIdFactory"),
    );
    expect(derivation).not.toContain("Date.now(");
    expect(derivation).not.toContain("writeTimestamp");
  });

  it("mints a message id from an injected authority, never from storage", async () => {
    const factory = code(await read("packages/agent/src/messages/types/message-factory.ts"));
    expect(factory).toContain("ids.create()");
    expect(factory).not.toContain("agentMessageId(");
  });

  it("performs no I/O and no network call in the Message Domain", async () => {
    for (const file of await messageDomainFiles()) {
      const text = code(await read(file));
      for (const forbidden of ["fetch(", "await import(", "require("]) {
        expect(text, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("uses only node:crypto under the Message Domain", async () => {
    for (const file of await messageDomainFiles()) {
      const text = code(await read(file));
      for (const specifier of text.matchAll(/from\s+"(node:[^"]+)"/g)) {
        expect(["node:crypto"], `${file}: ${specifier[1] ?? ""}`).toContain(specifier[1] ?? "");
      }
    }
  });
});

describe("Phase 5A guard — source anchors", () => {
  it("reads a real file for every path this guard names", async () => {
    // A missing source file would make several assertions vacuously true.
    const anchors = [
      "packages/agent/src/messages/index.ts",
      "packages/agent/src/messages/types/ids.ts",
      "packages/agent/src/messages/types/audience.ts",
      "packages/agent/src/messages/types/source.ts",
      "packages/agent/src/messages/types/content.ts",
      "packages/agent/src/messages/types/message-base.ts",
      "packages/agent/src/messages/types/user-message.ts",
      "packages/agent/src/messages/types/assistant-message.ts",
      "packages/agent/src/messages/types/tool-result-message.ts",
      "packages/agent/src/messages/types/custom-agent-messages.ts",
      "packages/agent/src/messages/types/agent-message.ts",
      "packages/agent/src/messages/types/message-factory.ts",
      "packages/agent/src/messages/persistence/record.ts",
      "packages/agent/src/messages/codec/codec.ts",
      "packages/agent/src/messages/codec/standard-codecs.ts",
      "packages/agent/src/messages/codec/registry.ts",
      "packages/agent/src/messages/codec/registry-builder.ts",
      "packages/agent/src/messages/projection/projector.ts",
      "packages/agent/src/messages/projection/standard-projectors.ts",
      "packages/agent/src/messages/projection/registry.ts",
      "packages/agent/src/messages/projection/errors.ts",
      "packages/agent/src/messages/conversation/conversation-turn.ts",
      "packages/agent/src/messages/conversation/conversation-snapshot.ts",
      "packages/agent/src/messages/conversation/validator.ts",
      "packages/agent/src/messages/conversation/execution-unit.ts",
      "packages/agent/src/messages/conversation/token-estimator.ts",
      "packages/agent/src/messages/conversation/selector.ts",
      "packages/ai/src/messages/provider-state.ts",
      "packages/ai/src/messages/content.ts",
      "packages/ai/src/messages/message.ts",
      "packages/ai/src/index.ts",
      "packages/agent/src/index.ts",
      "packages/agent/src/loop/history/conversation-history.ts",
      "packages/agent/src/loop/context/context-engine-port.ts",
      "packages/agent/src/run/ports/run-execution-store.ts",
      "packages/context/src/execution-unit.ts",
      "packages/context/src/token-estimator.ts",
      "packages/client/src/index.ts",
      "packages/agent/test/messages/independent-use.test.ts",
    ];
    for (const anchor of anchors) {
      expect(await exists(anchor), anchor).toBe(true);
      expect((await sourceOrEmpty(anchor)).length, anchor).toBeGreaterThan(0);
    }
  });

  it("has no packages/message-system, packages/messages-v2 or packages/agent-message (freeze §172)", async () => {
    for (const forbidden of [
      "packages/message-system",
      "packages/messages-v2",
      "packages/agent-message",
      "packages/message-core",
    ]) {
      expect(await exists(forbidden), forbidden).toBe(false);
    }
    const workspaceFile = await read("pnpm-workspace.yaml");
    for (const forbidden of ["message-system", "messages-v2", "agent-message", "message-core"]) {
      expect(workspaceFile, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps the Message Domain inside @caelush/agent (freeze §172)", async () => {
    for (const manifestPath of await manifestPaths()) {
      if (manifestPath === "packages/agent/package.json") continue;
      const parsed = await manifest(manifestPath);
      expect(String(parsed["name"] ?? ""), manifestPath).not.toMatch(
        /message-system|messages-v2|agent-message|message-core/,
      );
    }
  });
});
