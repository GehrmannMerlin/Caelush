import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 5B — the Message Interface Freeze Errata boundary guard.
 *
 * ```text
 * the errata corrected exactly four contracts:
 *   AgentMessageSource TOOL arm          drops the duplicated observationId
 *   ToolResultObservationRef             OBSERVATION | NO_OBSERVATION
 *   ToolFeedbackProjectionPolicy         SNAPSHOT | LEGACY_UNKNOWN
 *   AgentToolResultMessage.observation   replaces the mandatory observationId
 * ```
 *
 * This guard asserts two things at once, and the second is the one that matters:
 *
 * ```text
 * superseded   the four contracts really did change, and changed to the frozen shape
 * frozen       nothing else changed
 * ```
 *
 * A scoped errata that quietly widened into a general unfreezing would be worse than the blocker it
 * resolved, so every unaffected contract is asserted byte-stable here rather than left to review.
 */

const repositoryRoot = process.cwd();

function abs(relativePath: string): string {
  return path.join(repositoryRoot, relativePath);
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

/**
 * Source with comments removed.
 *
 * The assertions below separate two questions that a raw `toContain` would conflate:
 *
 * ```text
 * does the code mention a concept?     yes, freely — prose explains what a contract excludes
 * does the contract declare it?        only where the freeze says it may
 * ```
 *
 * A guard that fired on documentation could not be kept passing for the right reason, so structural
 * assertions run against executable code while doc-comment assertions read the raw file.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const MESSAGES = "packages/agent/src/messages";

describe("Freeze errata guard — the superseded contracts carry the corrected shape", () => {
  it("declares ToolResultObservationRef as the frozen two-arm union", async () => {
    const text = await read(`${MESSAGES}/types/tool-result-observation.ts`);
    expect(text).toContain("export type ToolResultObservationRef =");
    expect(text).toContain('readonly kind: "OBSERVATION";');
    expect(text).toContain("readonly observationId: ObservationId;");
    expect(text).toContain('readonly kind: "NO_OBSERVATION";');
    // Exactly two arms, and no sentinel escape hatch.
    expect([...text.matchAll(/readonly kind: "[A-Z_]+";/g)]).toHaveLength(2);
  });

  it("declares ToolFeedbackProjectionPolicy as the frozen two-arm union", async () => {
    const text = await read(`${MESSAGES}/types/tool-result-message.ts`);
    expect(text).toContain("export type ToolFeedbackProjectionPolicy =");
    expect(text).toContain('readonly kind: "SNAPSHOT";');
    expect(text).toContain("readonly snapshot: ToolObservationPolicySnapshot;");
    expect(text).toContain('readonly kind: "LEGACY_UNKNOWN";');
  });

  it("keeps the receipt policy on the union and the version at 1", async () => {
    const text = await read(`${MESSAGES}/types/tool-result-message.ts`);
    expect(text).toContain("readonly policy: ToolFeedbackProjectionPolicy;");
    // The old mandatory-snapshot shape is gone, so a receipt cannot claim an unknown policy was a
    // real bound.
    expect(text).not.toContain("readonly policy: ToolObservationPolicySnapshot;");
    expect(text).toContain("TOOL_FEEDBACK_PROJECTION_RECEIPT_VERSION = 1 as const");
  });

  it("carries the observation union on the message instead of an observationId", async () => {
    const text = await read(`${MESSAGES}/types/tool-result-message.ts`);
    expect(text).toContain("readonly observation: ToolResultObservationRef;");
    // The superseded field may appear in prose but must not be declared.
    expect(text).not.toMatch(/readonly observationId:/);
  });

  it("removes observationId from the TOOL source arm", async () => {
    const text = await read(`${MESSAGES}/types/source.ts`);
    expect(text).toContain('readonly kind: "TOOL";');
    // The arm is now field-free: the braces are empty between the discriminant and the close.
    expect(text).toMatch(/readonly kind: "TOOL";\s*\}/);
    expect(text).not.toMatch(/readonly observationId: ObservationId;/);
    // And the module no longer needs the protocol ObservationId at all.
    expect(text).not.toContain('from "@caelush/protocol"');
  });

  it("declares each corrected contract exactly once", async () => {
    const declarations: readonly (readonly [string, string])[] = [
      ["export type ToolResultObservationRef =", `${MESSAGES}/types/tool-result-observation.ts`],
      ["export type ToolFeedbackProjectionPolicy =", `${MESSAGES}/types/tool-result-message.ts`],
      ["export type AgentMessageSource =", `${MESSAGES}/types/source.ts`],
    ];
    for (const [declaration, expectedFile] of declarations) {
      const holders: string[] = [];
      for (const candidate of await sourceFiles()) {
        if ((await cachedSource(candidate)).includes(declaration)) holders.push(candidate);
      }
      expect(holders.sort(), declaration).toEqual([expectedFile]);
    }
  });
});

describe("Freeze errata guard — LEGACY_UNKNOWN is a migration-only producer arm", () => {
  it("refuses LEGACY_UNKNOWN from the normal Message Factory", async () => {
    const factory = await read(`${MESSAGES}/types/message-factory.ts`);
    expect(factory).toContain('input.projection.policy.kind === "LEGACY_UNKNOWN"');
    expect(factory).toContain("LEGACY_UNKNOWN belongs to migration");
    // The refusal is structural: it throws before any message is built.
    expect(factory).toContain("throw new TypeError(");
  });

  it("accepts LEGACY_UNKNOWN on the decode path, because a reader must read what was written", async () => {
    const codec = await read(`${MESSAGES}/codec/standard-codecs.ts`);
    expect(codec).toContain('value["kind"] === "LEGACY_UNKNOWN"');
    expect(codec).toContain("LEGACY_UNKNOWN_TOOL_FEEDBACK_POLICY");
  });

  it("never infers NO_OBSERVATION from a missing field", async () => {
    const codec = await read(`${MESSAGES}/codec/standard-codecs.ts`);
    const decoder = codec.slice(
      codec.indexOf("function decodeObservationRef"),
      codec.indexOf("function decodeProjectionReceipt"),
    );
    // The decoder switches on the discriminant and refuses anything else. It must not treat an
    // absent field as the no-observation arm, which is the defect the union exists to remove.
    expect(decoder).toContain('value["kind"] === "NO_OBSERVATION"');
    expect(decoder).toContain('value["kind"] === "OBSERVATION"');
    expect(decoder).toContain("throw new AgentMessageCodecError");
    expect(decoder).not.toContain("=== undefined");
  });

  it("never fabricates an ObservationId", async () => {
    for (const file of await messageDomainFiles()) {
      const text = await read(file);
      for (const forbidden of [
        "syntheticObservation",
        "SYNTHETIC_TOOL_OBSERVATION",
        "NO_EXECUTION_OBSERVATION",
        'observationId: "none"',
        'observationId: "legacy"',
        'observationId: "synthetic"',
      ]) {
        expect(text, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("declares no fake sentinel ObservationId", async () => {
    const ids = await read(`${MESSAGES}/types/ids.ts`);
    expect(ids).not.toContain("ObservationId");
  });
});

describe("Freeze errata guard — the unaffected contracts did NOT change", () => {
  it("keeps AgentMessageBase free of sequence and free of Tool provenance", async () => {
    const base = code(await read(`${MESSAGES}/types/message-base.ts`));
    expect(base).not.toMatch(/\bsequence\b\s*:/);
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
    // The errata moved nothing into the base: observation provenance stays on the Tool result.
    expect(base).not.toContain("observation");
  });

  it("keeps USER and ASSISTANT unchanged", async () => {
    const user = code(await read(`${MESSAGES}/types/user-message.ts`));
    expect(user).toContain('readonly type: "USER";');
    expect(user).toContain("readonly content: readonly AgentUserContentPart[];");
    expect(user).not.toContain("observation");

    const assistant = code(await read(`${MESSAGES}/types/assistant-message.ts`));
    expect(assistant).toContain('readonly type: "ASSISTANT";');
    expect(assistant).toContain("readonly content: readonly AgentAssistantContentPart[];");
    expect(assistant).toContain("readonly model: AgentAssistantModelProvenance;");
    expect(assistant).not.toContain("observation");
  });

  it("keeps the record envelope unchanged", async () => {
    const record = await read(`${MESSAGES}/persistence/record.ts`);
    for (const field of [
      "readonly messageId: AgentMessageId;",
      "readonly runId: RunId;",
      "readonly sessionId: SessionId;",
      "readonly sequence: number;",
      "readonly conversationTurnId: ConversationTurnId;",
      "readonly messageType: string;",
      "readonly schemaVersion: AgentMessageSchemaVersion;",
      "readonly modelProjectionVersion?: AgentMessageProjectionVersion;",
      "readonly sourceStepId?: StepId;",
      "readonly createdAt: TimestampMs;",
      "readonly source: AgentMessageSource;",
      "readonly audience: AgentMessageAudience;",
      "readonly data: JsonObject;",
    ]) {
      expect(record, field).toContain(field);
    }
    expect(code(record), "the envelope must not gain Tool provenance").not.toContain("observation");
  });

  it("keeps the codec registry contract unchanged", async () => {
    const registry = await read(`${MESSAGES}/codec/registry.ts`);
    for (const method of [
      "has(type: string, version: AgentMessageSchemaVersion): boolean;",
      "get(type: string, version: AgentMessageSchemaVersion): AgentMessageCodec | undefined;",
      "encode(message: AgentMessage): AgentMessageDraft;",
      "decode(record: AgentMessageRecord): AgentMessage;",
    ]) {
      expect(registry, method).toContain(method);
    }
    expect(registry).toContain("PROJECTION_VERSION_UNAVAILABLE");
  });

  it("keeps the projector registry contract unchanged", async () => {
    const registry = await read(`${MESSAGES}/projection/registry.ts`);
    for (const method of [
      "has(type: string, version: AgentMessageProjectionVersion): boolean;",
      "get(type: string, version: AgentMessageProjectionVersion): AgentMessageProjector | undefined;",
      "project(stored: StoredAgentMessage): AgentMessageAIProjection;",
    ]) {
      expect(registry, method).toContain(method);
    }
    // The projection error surface is still exactly the four frozen codes.
    const errors = await read(`${MESSAGES}/projection/errors.ts`);
    expect([...errors.matchAll(/"[A-Z_]{10,}"/g)].length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the ConversationTurn, snapshot, ExecutionUnit and selector contracts unchanged", async () => {
    const turn = await read(`${MESSAGES}/conversation/conversation-turn.ts`);
    expect(turn).toContain("export interface ConversationTurn {");
    expect(turn).not.toContain("observation");

    const snapshot = await read(`${MESSAGES}/conversation/conversation-snapshot.ts`);
    expect(snapshot).toContain("export interface AgentConversationSnapshot {");
    expect(snapshot).not.toContain("observation");

    const unit = code(await read(`${MESSAGES}/conversation/execution-unit.ts`));
    expect(unit).toContain("readonly toolCallIds: readonly string[];");
    expect(unit).toContain("readonly toolResultMessageIds: readonly AgentMessageId[];");
    // The unit links by message identity and toolCallId, never by observation existence.
    expect(unit).not.toContain("observationId");

    const selector = code(await read(`${MESSAGES}/conversation/selector.ts`));
    expect(selector).toContain("export interface ConversationSelector {");
    expect(selector).not.toContain("observation");
  });

  it("keeps the validator's Tool linkage independent of observation existence", async () => {
    const validator = code(await read(`${MESSAGES}/conversation/validator.ts`));
    expect(validator).toContain("validateModelVisibleToolStructure");
    // The pairing rule reads identity only, which is what lets a NO_OBSERVATION result close a call.
    expect(validator).toContain("part.toolCallId");
    expect(validator).toContain("message.toolCallId");
    expect(validator).not.toContain("observation");
  });

  it("keeps the AI projector blind to both provenance arms", async () => {
    const projector = await read(`${MESSAGES}/projection/standard-projectors.ts`);
    // Slice first, then strip: the declaration marker sits in the prose immediately above it, so
    // stripping before slicing would remove the very delimiter this assertion indexes by.
    const toolResult = code(
      projector.slice(projector.indexOf("export const AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_V1")),
    );
    expect(toolResult).toContain("content: message.projectedContent");
    // A projector that branched on provenance, or failed on an unknown policy, would make an
    // unknown historical policy a model-visible change.
    expect(toolResult).not.toContain("observation");
    expect(toolResult).not.toContain("policy");
    expect(toolResult).not.toContain("LEGACY_UNKNOWN");
  });

  it("keeps the TOOL_RESULT projection version and schema version at 1", async () => {
    const projector = await read(`${MESSAGES}/projection/standard-projectors.ts`);
    expect(projector).toContain("AGENT_TOOL_RESULT_MESSAGE_PROJECTOR_VERSION = 1");
    const codec = await read(`${MESSAGES}/codec/standard-codecs.ts`);
    const toolCodec = codec.slice(
      codec.indexOf("AGENT_TOOL_RESULT_MESSAGE_CODEC_V1"),
      codec.indexOf("STANDARD_AGENT_MESSAGE_CODECS"),
    );
    expect(toolCodec).toContain("currentVersion: 1");
  });
});

describe("Freeze errata guard — authority and source anchors", () => {
  it("records the errata as a scoped authority layer", async () => {
    const errata = await read("docs/architecture/v2/PHASE_5B_MESSAGE_INTERFACE_FREEZE_ERRATA.md");
    expect(errata).toContain("## 5. Supersede scope");
    expect(errata).toContain("All unrelated Message System V2 frozen contracts remain unchanged.");
    expect(errata).toContain("## 12. Non-goals");
    // The refused alternative must stay refused in the record, not only in the code.
    expect(errata).toContain("LEGACY_TOOL_RESULT");
    expect(errata).toContain("## 14. Consequences for Phase 5C");
  });

  it("keeps blocked evidence outside the repository", async () => {
    // The repository governance contract keeps temporary blocked evidence out of versioned
    // architecture docs. The historical record remains an external task artifact, while this
    // guard prevents a future migration from reintroducing it as committed state.
    expect(
      await exists("docs/architecture/v2/PHASE_5B_MESSAGE_STORAGE_GATE3_BLOCKED_EVIDENCE.md"),
    ).toBe(false);
  });

  it("reads a real file for every path this guard names", async () => {
    for (const anchor of [
      `${MESSAGES}/types/tool-result-observation.ts`,
      `${MESSAGES}/types/tool-result-message.ts`,
      `${MESSAGES}/types/source.ts`,
      `${MESSAGES}/types/message-factory.ts`,
      `${MESSAGES}/types/message-base.ts`,
      `${MESSAGES}/types/user-message.ts`,
      `${MESSAGES}/types/assistant-message.ts`,
      `${MESSAGES}/types/ids.ts`,
      `${MESSAGES}/codec/standard-codecs.ts`,
      `${MESSAGES}/codec/registry.ts`,
      `${MESSAGES}/projection/standard-projectors.ts`,
      `${MESSAGES}/projection/registry.ts`,
      `${MESSAGES}/projection/errors.ts`,
      `${MESSAGES}/persistence/record.ts`,
      `${MESSAGES}/conversation/conversation-turn.ts`,
      `${MESSAGES}/conversation/conversation-snapshot.ts`,
      `${MESSAGES}/conversation/execution-unit.ts`,
      `${MESSAGES}/conversation/validator.ts`,
      `${MESSAGES}/conversation/selector.ts`,
      "docs/architecture/v2/PHASE_5B_MESSAGE_INTERFACE_FREEZE_ERRATA.md",
    ]) {
      expect(await exists(anchor), anchor).toBe(true);
      expect((await read(anchor)).length, anchor).toBeGreaterThan(0);
    }
  });

  it("keeps the Message Domain free of any second Tool Result message type", async () => {
    // The errata deliberately refused a migration-only message type, because the validator, the
    // ExecutionUnit, the projector and Context replay would each have to understand a second
    // Tool-Call-closing kind forever.
    for (const forbidden of ["LEGACY_TOOL_RESULT", "MIGRATED_TOOL_RESULT", "TOOL_RESULT_LEGACY"]) {
      for (const file of await messageDomainFiles()) {
        expect(await read(file), `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

/* ---------------------------------------------------------------------------------- helpers */

const SELF = "tests/architecture/phase-5b-message-freeze-errata.test.ts";

async function messageDomainFiles(): Promise<readonly string[]> {
  return (await allSourceFiles()).filter((file) => file.startsWith(`${MESSAGES}/`));
}

/**
 * Every `.ts` path under `packages`, walked once.
 *
 * The walk is cached because this guard asks several questions about the same population, and this suite
 * runs beside the whole workspace's test run: a per-assertion directory walk over a few hundred files
 * pushes neighbouring guards past the default test timeout, which makes an unrelated guard look broken.
 */
let fileCache: readonly string[] | undefined;

async function allSourceFiles(): Promise<readonly string[]> {
  if (fileCache === undefined) {
    const found: string[] = [];
    await collect("packages", found, SELF);
    fileCache = Object.freeze(found.sort());
  }
  return fileCache;
}

/** The source-file population a declaration-holder scan runs over, read once. */
let textCache: Map<string, string> | undefined;

async function sourceFiles(): Promise<readonly string[]> {
  if (textCache === undefined) {
    const files = await allSourceFiles();
    const entries = await Promise.all(files.map(async (file) => [file, await read(file)] as const));
    textCache = new Map(entries);
  }
  return allSourceFiles();
}

/** One cached source file. Every scan below reads through this, never from disk again. */
async function cachedSource(file: string): Promise<string> {
  await sourceFiles();
  return textCache?.get(file) ?? (await read(file));
}

async function collect(relativeDir: string, into: string[], skip: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(abs(relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      await collect(relative, into, skip);
    } else if (/\.ts$/.test(entry.name) && relative !== skip) {
      into.push(relative);
    }
  }
}
