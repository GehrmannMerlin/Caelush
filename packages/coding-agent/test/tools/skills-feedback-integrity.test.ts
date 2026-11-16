import {
  createRunId,
  createSessionId,
  createStepId,
  createToolInvocationId,
} from "@caelush/protocol";
import {
  createControlHookId,
  type ControlHookContext,
  type ToolExecutionIdentity,
} from "@caelush/agent";
import { describe, expect, it } from "vitest";
import {
  createDefaultCodingTools,
  createToolFeedbackContributionPipeline,
} from "@caelush/coding-agent";

const BODY = "SECRET_SKILL_BODY_MUST_STAY_OUT_OF_FEEDBACK";

describe("Skill Tool feedback isolation", () => {
  it("feeds only the core-read marker to feedback hooks and preserves the separate binding", async () => {
    const runId = createRunId();
    const invocationId = createToolInvocationId();
    const binding = {
      runId,
      resourceKind: "WORKFLOW_INSTRUCTION",
      resourceId: "skill_feedback_test",
      resourceRevision: `sha256:${"b".repeat(64)}`,
      artifactRef: "skill-bundle:feedback-private-ref",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      utf8Bytes: Buffer.byteLength(BODY, "utf8"),
      tokenEstimate: Math.ceil(Buffer.byteLength(BODY, "utf8") / 3),
      sourceToolInvocationId: invocationId,
    };
    const definitions = createDefaultCodingTools({
      readFile: {},
      readOnly: {},
      patch: {},
      exec: {},
      process: {},
      git: {},
      skills: {
        async search() {
          return { items: [], inventoryComplete: true };
        },
        async read() {
          return { kind: "CORE_CONTENT_READY", bindingDraft: binding };
        },
      },
    } as never);
    const readSkill = definitions.find(({ tool }) => tool.name === "read_skill")?.tool;
    expect(readSkill).toBeDefined();

    const identity: ToolExecutionIdentity = {
      runId,
      sessionId: createSessionId(),
      sourceStepId: createStepId(),
      invocationId,
      externalCallId: "call_feedback_1",
    };
    const execution = (await readSkill!.execute({
      identity,
      args: { skillId: "skill_feedback_test" },
      environment: {
        workspace: { id: "workspace_feedback" as never, path: "/private/workspace" },
        runtime: { id: "local", kind: "local" },
      },
      signal: new AbortController().signal,
      updates: { publish: () => undefined },
    } as never)) as unknown as {
      readonly result: {
        readonly content: string;
        readonly details: Record<string, unknown>;
        readonly isError: boolean;
      };
      readonly preparedResourceBindings: readonly unknown[];
    };

    const seen: unknown[] = [];
    const hookId = createControlHookId("skill-feedback-inspector");
    const context: ControlHookContext = {
      identity: { runId, sessionId: identity.sessionId },
      stepId: identity.sourceStepId,
      mode: "EXECUTE",
      signal: new AbortController().signal,
    };
    const feedback = createToolFeedbackContributionPipeline({
      registrations: [
        {
          id: hookId,
          priority: 1,
          criticality: "REQUIRED",
          timeoutMs: 100,
          hook: {
            async contribute(input) {
              seen.push(input);
              return [{ id: "safe-marker", text: "marker observed", placement: "APPEND" }];
            },
          },
        },
      ],
      textSanitizer: (value) => value,
    });
    const result = await feedback.contribute(
      {
        runId,
        sessionId: identity.sessionId,
        sourceStepId: identity.sourceStepId,
        toolCallId: identity.externalCallId,
        toolName: "read_skill",
        observationId: "observation_feedback" as never,
        isError: execution.result.isError,
        builtInFeedback: execution.result.content,
        safeObservationSummary: { state: "CONTENT_READY" },
      },
      context,
    );

    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain(BODY);
    expect(JSON.stringify(seen[0])).not.toContain("feedback-private-ref");
    expect(JSON.stringify(seen[0])).not.toContain("sourceFingerprint");
    expect(result.content).toContain(execution.result.content);
    expect(result.content).not.toContain(BODY);
    expect(execution.preparedResourceBindings).toEqual([binding]);
    expect(execution.preparedResourceBindings[0]).toEqual(binding);
  });
});
