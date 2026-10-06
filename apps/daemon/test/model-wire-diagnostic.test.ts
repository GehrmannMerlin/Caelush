import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCaelushStorage, type CaelushStorage } from "@caelush/storage";
import type {
  AIAdapterEvent,
  ApiAdapter,
  ApiAdapterStreamInput,
  ModelDescriptor,
  ModelDescriptorSourcePort,
} from "@caelush/ai";
import { createRunId, createSessionId, createStepId } from "@caelush/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { composeDaemon, type DaemonComposition } from "../src/daemon-composition.js";
import type { ModelWireDiagnosticEvent } from "../src/providers/model-wire-diagnostic.js";
import {
  FIXTURE_API,
  fixtureBinding,
  fixtureDescriptor,
  fixtureModelSource,
} from "./support/ai-fixture.js";

/**
 * The model wire diagnostic must be observable without being leaky.
 *
 * It is a transparent decorator over the frozen gateway, so the only thing it may
 * record is safe structural metadata. Everything an operator would consider sensitive —
 * the endpoint, the credential, the prompt, the tool arguments — must stay inside the
 * adapter boundary.
 */

const SECRET_KEY = "fake-secret-123";
const SECRET_ENDPOINT = "http://secret-host.internal:9999/v1";
const SECRET_PROMPT = "CAELUSH_PROMPT_SECRET_DO_NOT_LEAK";
const SECRET_TOOL_ARGUMENT = "CAELUSH_TOOL_SECRET_DO_NOT_LEAK";

let directory: string | undefined;
let storage: CaelushStorage | undefined;
let composition: DaemonComposition | undefined;

afterEach(async () => {
  await composition?.dispose().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  storage = undefined;
  composition = undefined;
});

class RecordingAdapter implements ApiAdapter {
  readonly id = FIXTURE_API;

  constructor(private readonly text = "answer") {}

  async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    // The adapter *does* see the credential and the endpoint. That is exactly why the
    // diagnostic must be checked separately: seeing them here is legitimate, recording
    // them is not.
    void input.provider.credentials;
    void input.provider.endpoint;
    yield {
      type: "tool_call.start",
      payload: { toolCallId: "call_secret", toolName: "read_file" },
    };
    yield {
      type: "tool_call.completed",
      payload: {
        id: "call_secret",
        name: "read_file",
        input: { path: SECRET_TOOL_ARGUMENT },
      },
    };
    yield { type: "text.delta", payload: { text: this.text } };
    yield { type: "adapter.finish", payload: { finishReason: "TOOL_CALLS" } };
  }
}

function automaticCacheFixtureSource(): ModelDescriptorSourcePort & {
  list(): readonly ModelDescriptor[];
} {
  const base = fixtureDescriptor();
  const descriptor: ModelDescriptor = {
    ...base,
    capabilities: { ...base.capabilities, promptCaching: "SUPPORTED" },
    cache: { supportedRetentions: ["NONE", "SHORT"], defaultRetention: "SHORT" },
    adapterMetadata: { "openai-compatible": { cacheDialect: "AUTOMATIC" } },
  };
  return {
    id: "wire-diagnostic-cache-fixture",
    priority: 0,
    resolve: (ref) =>
      ref.provider === descriptor.ref.provider && ref.model === descriptor.ref.model
        ? descriptor
        : undefined,
    list: () => [descriptor],
  };
}

describe("daemon model wire diagnostic", () => {
  it("does not publish verification review text as a public transient model delta", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-verification-stream-silence-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const transients: import("@caelush/protocol").TransientRunEvent[] = [];

    composition = await composeDaemon({
      storage,
      modelSources: [fixtureModelSource()],
      providerBindings: [fixtureBinding()],
      adapterOverrides: [new RecordingAdapter('{"verdict":"PASS","summary":"ok"}')],
      notifier: {
        notifyCommitted: () => undefined,
        emitTransient: (event) => transients.push(event),
      },
    });

    const identity = composition.resolveTurnIdentity({
      id: createRunId(),
      sessionId: createSessionId(),
      goal: "review a candidate answer",
    });
    const request = {
      model: { provider: "fixture", model: "fixture-model" },
      messages: [{ role: "user" as const, content: "Return a verification review." }],
    };
    const result = await composition.verificationModelTurns.execute({
      identity,
      request,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ finishReason: "TOOL_CALLS" });
    expect(transients.filter((event) => event.type === "model.text.delta")).toEqual([]);

    await composition.modelTurnExecutor.execute({
      identity,
      turn: { stepId: createStepId(), sequence: 1 },
      request,
      signal: new AbortController().signal,
    });
    expect(transients.filter((event) => event.type === "model.text.delta")).toHaveLength(1);
    expect(transients[0]).toMatchObject({
      type: "model.text.delta",
      payload: { text: '{"verdict":"PASS","summary":"ok"}' },
    });
  });

  it("records structural facts and never an endpoint, a credential, a prompt or a tool argument", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-wire-diagnostic-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const recorded: ModelWireDiagnosticEvent[] = [];

    composition = await composeDaemon({
      storage,
      modelSources: [automaticCacheFixtureSource()],
      providerBindings: [
        fixtureBinding({
          endpoint: SECRET_ENDPOINT,
          credentials: { resolve: async () => ({ apiKey: SECRET_KEY }) },
        }),
      ],
      adapterOverrides: [new RecordingAdapter()],
      wireDiagnosticWriter: (event) => recorded.push(event),
    });

    // The frozen model turn executor carries an explicit Run identity, because the durable
    // model turn boundary commits against a Run and a Session. Phase 3E removed the mutable
    // global this used to be published through: the identity is a pure projection of a Run
    // and travels with the turn, so nothing here depends on publish ordering.
    const identity = composition.resolveTurnIdentity({
      id: createRunId(),
      sessionId: createSessionId(),
      goal: "diagnose the model wire",
    });

    await composition.verificationModelTurns.execute({
      identity,
      request: {
        model: { provider: "fixture", model: "fixture-model" },
        messages: [
          { role: "system", content: "system instructions" },
          { role: "user", content: SECRET_PROMPT },
        ],
        tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
        toolChoice: { type: "AUTO" },
        settings: { cache: { retention: "SHORT", key: "CACHE_KEY_SENTINEL" } },
      },
      signal: new AbortController().signal,
    });

    // The diagnostic actually observed the invocation in both directions.
    expect(recorded.map((event) => event.phase)).toEqual(["REQUEST", "RESPONSE"]);
    const request = recorded[0];
    expect(request).toMatchObject({
      phase: "REQUEST",
      providerId: "fixture",
      model: "fixture-model",
      messageRoles: ["system", "user"],
      toolNames: ["read_file"],
      modelSettings: {
        cacheRequestedRetention: "SHORT",
        cacheEffectiveRetention: "SHORT",
        cacheMode: "EXACT",
        cacheDialect: "AUTOMATIC",
      },
    });
    // Identity, roles and names are the whole payload; nothing else is available.
    expect(Object.keys(request ?? {}).sort()).toEqual([
      "callId",
      "messageRoles",
      "model",
      "modelSettings",
      "phase",
      "providerId",
      "toolNames",
    ]);
    expect(Object.keys((request?.modelSettings ?? {}) as Record<string, unknown>).sort()).toEqual([
      "cacheDialect",
      "cacheEffectiveRetention",
      "cacheMode",
      "cacheRequestedRetention",
      "toolChoice",
    ]);

    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(SECRET_ENDPOINT);
    expect(serialized).not.toContain("secret-host.internal");
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain(SECRET_TOOL_ARGUMENT);
    expect(serialized).not.toContain("CACHE_KEY_SENTINEL");
    // The response side is a finish reason and the requested tool name only.
    expect(recorded[1]).toMatchObject({
      phase: "RESPONSE",
      finishReason: "TOOL_CALLS",
      toolNames: ["read_file"],
    });
  });

  it("stays silent unless the operator asks for it", async () => {
    directory = await mkdtemp(join(tmpdir(), "caelush-wire-diagnostic-off-"));
    storage = await openCaelushStorage({ path: join(directory, "caelush.db") });
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      composition = await composeDaemon({
        storage,
        modelSources: [fixtureModelSource()],
        providerBindings: [fixtureBinding()],
        adapterOverrides: [new RecordingAdapter()],
      });

      const identity = composition.resolveTurnIdentity({
        id: createRunId(),
        sessionId: createSessionId(),
        goal: "diagnose the model wire",
      });

      await composition.verificationModelTurns.execute({
        identity,
        request: {
          model: { provider: "fixture", model: "fixture-model" },
          messages: [{ role: "user", content: SECRET_PROMPT }],
        },
        signal: new AbortController().signal,
      });
    } finally {
      process.stderr.write = original;
    }

    expect(written.join("")).not.toContain("wire_");
    expect(written.join("")).not.toContain("REQUEST");
  });
});
