import { describe, expect, it } from "vitest";
import {
  createContextDocumentBuilder,
  createContextPolicy,
  createContextPlanner,
  createContextRehydrator,
  createWorkflowInstructionContextSourceProvider,
  createPromptSurfaceSectionStates,
  diffPromptSurfaceSections,
  renderPromptSurfaceRecord,
  type ContextSourceInput,
} from "@caelush/agent";
import {
  createRunId,
  createSessionId,
  createWorkspaceId,
  WorkflowResourceBindingV1Schema,
} from "@caelush/protocol";
import type { ModelDescriptor } from "@caelush/ai";
import { createWorkflowResourceReader } from "../src/skills/workflow-resource-reader.js";

const MODEL: ModelDescriptor = {
  ref: { provider: "fixture", model: "workflow-recovery" },
  api: "fixture-chat",
  limits: { contextWindowTokens: 8_000, maxOutputTokens: 256 },
  capabilities: {
    streaming: "UNKNOWN",
    toolCalling: "UNKNOWN",
    parallelToolCalls: "UNKNOWN",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "UNKNOWN",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  source: "CONFIGURATION",
};

const runId = createRunId();
const workspaceId = createWorkspaceId();
const binding = WorkflowResourceBindingV1Schema.parse({
  runId,
  resourceKind: "WORKFLOW_INSTRUCTION",
  resourceId: "skill:repair",
  resourceRevision: "sha256:bundle-v1",
  artifactRef: "skill:repair-v1",
  sourceFingerprint: "sha256:manifest-v1",
  utf8Bytes: Buffer.byteLength("Complete original workflow instructions."),
  tokenEstimate: Math.ceil(Buffer.byteLength("Complete original workflow instructions.") / 3),
  bindingId: "binding:repair",
  activationOrdinal: 1,
});

const profile = {
  runId,
  profileVersion: 1 as const,
  workflowRendererVersion: "workflow-resource@1",
  catalogSnapshotRef: {
    catalogRevision: "catalog-v1",
    artifactRef: "workflow:catalog-v1",
    manifestFingerprint: "sha256:catalog-v1",
  },
};

function fixedReader(
  options: {
    readonly body?: string;
    readonly rendererVersion?: string;
    readonly bindingRunId?: ReturnType<typeof createRunId>;
    readonly resourceFingerprint?: string;
  } = {},
) {
  const body = options.body ?? "Complete original workflow instructions.";
  const manifest = `---\nname: repair\ndescription: Repair workflow\nuser-invocable: true\n---\n${body}`;
  return createWorkflowResourceReader({
    runs: {
      async get() {
        return { workspace: { id: workspaceId } } as never;
      },
      async readWorkflowProfile() {
        return {
          ...profile,
          ...(options.rendererVersion === undefined
            ? {}
            : { workflowRendererVersion: options.rendererVersion }),
        };
      },
      async readPreparedResources() {
        return [
          WorkflowResourceBindingV1Schema.parse({
            ...binding,
            runId: options.bindingRunId ?? runId,
          }),
        ];
      },
    },
    snapshots: {
      async readRunSkillCatalogSnapshot() {
        return {
          workspaceId,
          catalogRevision: "catalog-v1",
          complete: true,
          skills: [
            {
              skillId: "skill:repair",
              name: "repair",
              bundle: {
                bundleRevision: "sha256:bundle-v1",
                artifactRef: "skill:repair-v1",
                manifestFingerprint: "sha256:manifest-v1",
              },
            },
          ],
        } as never;
      },
    },
    bundles: {
      async capture() {
        throw new Error("recovery must not capture the latest source");
      },
      async read() {
        return {
          kind: "TEXT" as const,
          relativePath: "SKILL.md",
          contentType: "text/markdown",
          fingerprint: options.resourceFingerprint ?? "sha256:manifest-v1",
          complete: true,
          text: manifest,
        };
      },
    },
  });
}

function sourceInput(signal = new AbortController().signal): ContextSourceInput {
  return {
    identity: { runId, sessionId: createSessionId(), goal: "Repair the repository" },
    turn: { stepId: "step:workflow-recovery" as never, sequence: 2 },
    conversation: {} as never,
    input: { kind: "CONTINUATION", reason: "STEERING" },
    model: MODEL,
    mode: "NORMAL",
    policy: { effectiveInputLimitTokens: 8_000 } as never,
    signal,
  };
}

describe("Phase 04 fixed workflow Context recovery", () => {
  it("restores the full Run-bound body after the live source changes", async () => {
    let currentSourceBody = "Complete original workflow instructions.";
    const reader = fixedReader({ body: currentSourceBody });
    currentSourceBody = "Changed live source instructions.";
    const provider = createWorkflowInstructionContextSourceProvider({ reader });
    const collected = await provider.collect(sourceInput());

    expect(currentSourceBody).toBe("Changed live source instructions.");
    expect(collected.items).toHaveLength(1);
    expect(collected.items[0]?.payload).toMatchObject({
      kind: "TEXT",
      text: expect.stringContaining("Complete original workflow instructions."),
    });
    expect(collected.items[0]?.payload).not.toMatchObject({
      text: expect.stringContaining("Changed live source instructions."),
    });
  });

  it("does not append a second body while its fragment anchor survives marker compression", async () => {
    const collected = await createWorkflowInstructionContextSourceProvider({
      reader: fixedReader(),
    }).collect(sourceInput());
    const plan = createContextPlanner().plan({
      items: collected.items,
      policy: createContextPolicy({ model: MODEL, tools: [] }),
    });
    const document = createContextDocumentBuilder().build({
      plan,
      rehydrated: await createContextRehydrator().rehydrate({
        authorities: { goal: "Repair the repository" },
      }),
    });
    const states = createPromptSurfaceSectionStates(document);
    const preparedProjection = (
      collected as unknown as {
        readonly preparedWorkflowProjection?: {
          readonly resources: readonly Record<string, unknown>[];
        };
      }
    ).preparedWorkflowProjection;
    expect(preparedProjection?.resources[0]?.fragmentAnchor).toBe(workflowAnchor(states));
    const firstRecord = renderPromptSurfaceRecord(
      "BASELINE",
      states.map((state) => ({ op: "SET" as const, ...state })),
      4,
    );
    const markerCompressedRecord = diffPromptSurfaceSections(states, states, false);

    expect(firstRecord.match(/Complete original workflow instructions\./gu)).toHaveLength(1);
    expect(markerCompressedRecord.kind).toBe("NOOP");
    expect(markerCompressedRecord.updates).toEqual([]);
  });

  it("reconstructs the same full fragment and hash after its anchor is lost", async () => {
    const collected = await createWorkflowInstructionContextSourceProvider({
      reader: fixedReader(),
    }).collect(sourceInput());
    const plan = createContextPlanner().plan({
      items: collected.items,
      policy: createContextPolicy({ model: MODEL, tools: [] }),
    });
    const document = createContextDocumentBuilder().build({
      plan,
      rehydrated: await createContextRehydrator().rehydrate({
        authorities: { goal: "Repair the repository" },
      }),
    });
    const current = createPromptSurfaceSectionStates(document);
    const workflow = current.find((state) => state.content.includes("workflow_instruction"));
    if (workflow === undefined) throw new Error("workflow anchor was not projected");
    const preparedProjection = (
      collected as unknown as {
        readonly preparedWorkflowProjection?: {
          readonly resources: readonly Record<string, unknown>[];
        };
      }
    ).preparedWorkflowProjection;
    expect(preparedProjection?.resources[0]?.fragmentAnchor).toBe(workflow.stateKey);
    const recovered = diffPromptSurfaceSections(
      current.filter((state) => state.stateKey !== workflow.stateKey),
      current,
      false,
    );

    expect(recovered.kind).toBe("DELTA");
    expect(recovered.updates).toEqual([{ op: "SET", ...workflow }]);
    expect(recovered.updates[0]?.contentHash).toBe(workflow.contentHash);
    expect(
      renderPromptSurfaceRecord("DELTA", recovered.updates, 4).match(
        /Complete original workflow instructions\./gu,
      ),
    ).toHaveLength(1);
  });

  it("rejects a resource bound to a different Run before returning prepared projections", async () => {
    await expect(
      createWorkflowInstructionContextSourceProvider({
        reader: fixedReader({ bindingRunId: createRunId() }),
      }).collect(sourceInput()),
    ).rejects.toThrow();
  });

  it("fails closed for an unknown renderer and a changed fixed artifact", async () => {
    await expect(
      createWorkflowInstructionContextSourceProvider({
        reader: fixedReader({ rendererVersion: "workflow-resource@future" }),
      }).collect(sourceInput()),
    ).rejects.toThrow(/renderer/u);
    await expect(
      createWorkflowInstructionContextSourceProvider({
        reader: fixedReader({
          body: "Modified original workflow instructions.",
          resourceFingerprint: "sha256:wrong-artifact",
        }),
      }).collect(sourceInput()),
    ).rejects.toThrow(/fixed reference integrity/u);
  });
});

function workflowAnchor(
  states: readonly { readonly stateKey: string; readonly content: string }[],
) {
  return states.find((state) => state.content.includes("workflow_instruction"))?.stateKey;
}
