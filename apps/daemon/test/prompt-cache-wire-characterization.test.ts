import { describe, expect, it } from "vitest";

import {
  createContextDocumentBuilder,
  createContextFingerprint,
  createContextItem,
  createContextItemId,
  createContextMaterializer,
  createContextPlanner,
  createContextPolicy,
  createContextSourceId,
  createModelRequestBuilder,
  createStandardAgentMessageProjectorRegistry,
  createUtf8HeuristicTokenEstimator,
  type ContextBuildReport,
  type PreparedAgentContext,
  type PreparedModelContext,
} from "@caelush/agent";
import {
  createAISubsystem,
  type AIMessage,
  type AIModelRequest,
  type AIModelSettings,
  type AIToolSpec,
  type ModelDescriptor,
  type ModelDescriptorSourcePort,
} from "@caelush/ai";
import {
  createOpenAICompatibleApiAdapter,
  OPENAI_COMPATIBLE_API_ID,
} from "@caelush/ai/adapters/openai-compatible";

import {
  createControllableProviderServer,
  sendOpenAIText,
} from "./support/controllable-provider-server.js";

interface SafeFirstDifference {
  readonly section: "instructions" | "messages" | "tools" | "settings";
  readonly path: string;
  readonly arrayIndex?: number;
  readonly category: "VALUE_CHANGED" | "FIELD_ADDED" | "FIELD_REMOVED" | "ARRAY_LENGTH_CHANGED";
}

const PROVIDER_ID = "prompt-cache-wire-fixture";
const MODEL_ID = "offline-wire-model";
const MODEL: ModelDescriptor = {
  ref: { provider: PROVIDER_ID, model: MODEL_ID },
  api: OPENAI_COMPATIBLE_API_ID,
  limits: { contextWindowTokens: 8_192, maxOutputTokens: 2_048 },
  capabilities: {
    streaming: "SUPPORTED",
    toolCalling: "SUPPORTED",
    parallelToolCalls: "SUPPORTED",
    structuredOutput: "UNKNOWN",
    vision: "UNKNOWN",
    reasoning: "SUPPORTED",
    reasoningSummary: "UNKNOWN",
    promptCaching: "UNKNOWN",
    usageReporting: "UNKNOWN",
  },
  reasoning: { supportedLevels: ["LOW"], supportsSummary: "UNKNOWN" },
  source: "CONFIGURATION",
};
const MODEL_SETTINGS: AIModelSettings = {
  reasoning: { level: "LOW" },
  temperature: 0.25,
  maxOutputTokens: 512,
};
const CONTEXT_REPORT: ContextBuildReport = {
  estimatedInputTokens: 32,
  effectiveInputLimitTokens: MODEL.limits.contextWindowTokens,
  remainingTokens: MODEL.limits.contextWindowTokens - 32,
  pressure: "NORMAL",
  compactionCount: 0,
  requestOverheadTokens: 0,
  contributions: [],
};
const OBSERVATION_POLICY = {
  maxSingleObservationTokens: 100,
  maxObservationBatchTokens: 200,
} as const;
const CONTENT_MARKERS = [
  "PROMPT_CONTENT_SENTINEL",
  "TOOL_ARGUMENT_SENTINEL",
  "HOST_PATH_SENTINEL",
  "CREDENTIAL_SENTINEL",
];

const TOOL: AIToolSpec = {
  name: "read_file",
  description: "Read one file from the workspace.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

function preparedContext(workCommentary: string): PreparedAgentContext {
  const instruction = createContextItem({
    id: createContextItemId("reference:stable-instruction"),
    type: "coding.project_instruction",
    source: {
      providerId: createContextSourceId("coding.project-instructions"),
      sourceRef: "project-instructions",
      version: "v1",
    },
    scope: "PROJECT",
    retention: "PINNED",
    priorityClass: "HIGH",
    tokenEstimate: 4,
    cacheStability: "STABLE",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "stable project instruction",
    payload: { kind: "TEXT", text: "Use the established project conventions." },
  });
  const commentary = createContextItem({
    id: createContextItemId("commentary:work-status"),
    type: "agent.extension-contribution",
    source: {
      providerId: createContextSourceId("agent.extension-contributions"),
      sourceRef: "hook/work-commentary",
      version: "v1",
    },
    scope: "TURN",
    retention: "EPHEMERAL",
    priorityClass: "HIGH",
    tokenEstimate: 8,
    cacheStability: "DYNAMIC",
    freshness: "CURRENT",
    sensitivity: "INTERNAL",
    whyLoaded: "current work commentary",
    payload: { kind: "TEXT", text: workCommentary + "; PROMPT_CONTENT_SENTINEL" },
  });
  const policy = createContextPolicy({
    model: MODEL,
    requestOverhead: { toolSchemaTokens: 0, protocolOverheadTokens: 0, totalTokens: 0 },
    options: { outputReserveTokens: 1, safetyReserveTokens: 1 },
  });
  const plan = createContextPlanner().plan({ items: [instruction, commentary], policy });
  const document = createContextDocumentBuilder().build({
    plan,
    rehydrated: {
      goal: "Inspect the current workspace state.",
      changedFiles: [],
      pendingApprovals: [],
      activeProcesses: [],
      verificationState: "not-run",
      resourceGovernance: "bounded",
      projectFacts: [],
    },
  });
  const fingerprint = createContextFingerprint("sha256:wire-characterization");

  return {
    conversationMessages: [],
    document,
    plan,
    receipt: {
      contextFingerprint: fingerprint,
      mode: "NORMAL",
      modelRef: MODEL.ref,
      policyFingerprint: "sha256:stable-wire-policy",
      sources: [],
      budget: plan.budget,
      pressure: plan.pressure,
      toolSchemaTokens: 0,
      materializedTokens: 0,
    },
    observationPolicy: OBSERVATION_POLICY,
    contextFingerprint: fingerprint,
  };
}

async function request(
  workCommentary: string,
  priorRuntimeSnapshots: readonly string[] = [],
): Promise<AIModelRequest> {
  const materializer = createContextMaterializer({
    projectors: createStandardAgentMessageProjectorRegistry(),
    tokenEstimator: createUtf8HeuristicTokenEstimator(),
  });
  const materialized = await materializer.materialize({
    prepared: preparedContext(workCommentary),
    model: MODEL,
    signal: new AbortController().signal,
  });
  const messages: readonly AIMessage[] = [
    ...materialized,
    { role: "user", content: "Continue the same task." },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "fixture-call",
          toolName: "read_file",
          input: {
            path: "HOST_PATH_SENTINEL",
            query: "TOOL_ARGUMENT_SENTINEL",
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "fixture-call",
      toolName: "read_file",
      content: "bounded local fixture result",
      isError: false,
    },
    ...priorRuntimeSnapshots.map((content) => ({ role: "user" as const, content })),
    { role: "user", content: runtimeSnapshot(workCommentary) },
  ];
  const context: PreparedModelContext = {
    messages,
    report: CONTEXT_REPORT,
    observationPolicy: OBSERVATION_POLICY,
    contextFingerprint: "sha256:materialized-wire-context",
  };

  return createModelRequestBuilder().build({
    context,
    model: MODEL,
    tools: [TOOL],
    settings: MODEL_SETTINGS,
  });
}

function runtimeSnapshot(workCommentary: string): string {
  return [
    '<runtime_context_snapshot state="CURRENT">',
    `[TEST|DYNAMIC|INTERNAL] current-runtime-state\n${workCommentary}; PROMPT_CONTENT_SENTINEL`,
    "</runtime_context_snapshot>",
  ].join("\n");
}

function firstDifference(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): SafeFirstDifference | undefined {
  const instructions = firstInstructionDifference(left, right);
  if (instructions !== undefined) return instructions;

  const messagesDifference = compareValue(
    left["messages"],
    right["messages"],
    "messages",
    "messages",
  );
  if (messagesDifference !== undefined) return messagesDifference;

  const toolsDifference = compareValue(left["tools"], right["tools"], "tools", "tools");
  if (toolsDifference !== undefined) return toolsDifference;

  const leftSettings = withoutKeys(left, ["messages", "tools"]);
  const rightSettings = withoutKeys(right, ["messages", "tools"]);
  return compareValue(leftSettings, rightSettings, "settings", "settings");
}

function firstInstructionDifference(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): SafeFirstDifference | undefined {
  const leftMessages = Array.isArray(left["messages"]) ? left["messages"] : [];
  const rightMessages = Array.isArray(right["messages"]) ? right["messages"] : [];
  const count = Math.min(leftMessages.length, rightMessages.length);
  for (let index = 0; index < count; index += 1) {
    const leftMessage = asRecord(leftMessages[index]);
    const rightMessage = asRecord(rightMessages[index]);
    if (leftMessage?.["role"] !== "system" || rightMessage?.["role"] !== "system") continue;
    const difference = compareValue(
      leftMessage["content"],
      rightMessage["content"],
      "messages[" + index + "].content",
      "instructions",
      index,
    );
    if (difference !== undefined) return difference;
  }
  return undefined;
}

function compareValue(
  left: unknown,
  right: unknown,
  path: string,
  section: SafeFirstDifference["section"],
  firstArrayIndex?: number,
): SafeFirstDifference | undefined {
  if (Object.is(left, right)) return undefined;

  if (Array.isArray(left) && Array.isArray(right)) {
    const commonLength = Math.min(left.length, right.length);
    for (let index = 0; index < commonLength; index += 1) {
      const difference = compareValue(
        left[index],
        right[index],
        path + "[" + index + "]",
        section,
        firstArrayIndex ?? index,
      );
      if (difference !== undefined) return difference;
    }
    if (left.length !== right.length) {
      return {
        section,
        path,
        ...(firstArrayIndex === undefined
          ? { arrayIndex: commonLength }
          : { arrayIndex: firstArrayIndex }),
        category: "ARRAY_LENGTH_CHANGED",
      };
    }
    return undefined;
  }

  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord !== undefined && rightRecord !== undefined) {
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    for (const key of keys) {
      const memberPath = path.length === 0 ? key : path + "." + key;
      const hasLeft = Object.prototype.hasOwnProperty.call(leftRecord, key);
      const hasRight = Object.prototype.hasOwnProperty.call(rightRecord, key);
      if (!hasLeft || !hasRight) {
        return {
          section,
          path: memberPath,
          ...(firstArrayIndex === undefined ? {} : { arrayIndex: firstArrayIndex }),
          category: hasLeft ? "FIELD_REMOVED" : "FIELD_ADDED",
        };
      }
      const difference = compareValue(
        leftRecord[key],
        rightRecord[key],
        memberPath,
        section,
        firstArrayIndex,
      );
      if (difference !== undefined) return difference;
    }
    return undefined;
  }

  return {
    section,
    path,
    ...(firstArrayIndex === undefined ? {} : { arrayIndex: firstArrayIndex }),
    category: "VALUE_CHANGED",
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function withoutKeys(
  value: Readonly<Record<string, unknown>>,
  excluded: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key)));
}

describe("OpenAI-compatible prompt-cache wire characterization", () => {
  it("reports an earlier changed array element before a later append", () => {
    const difference = firstDifference(
      { messages: [{ role: "user", content: "A" }] },
      {
        messages: [
          { role: "user", content: "B" },
          { role: "user", content: "later appended message" },
        ],
      },
    );

    expect(difference).toEqual({
      section: "messages",
      path: "messages[0].content",
      arrayIndex: 0,
      category: "VALUE_CHANGED",
    });
  });

  it("keeps the stable head and prior request prefix while appending the current snapshot", async () => {
    const server = await createControllableProviderServer((_request, response) => {
      sendOpenAIText(response, "offline fixture response");
    });
    const modelSource: ModelDescriptorSourcePort & { list(): readonly ModelDescriptor[] } = {
      id: "prompt-cache-wire-characterization",
      priority: 0,
      resolve: (ref) =>
        ref.provider === PROVIDER_ID && ref.model === MODEL_ID ? MODEL : undefined,
      list: () => [MODEL],
    };

    try {
      const ai = createAISubsystem({
        modelSources: [modelSource],
        providers: [
          {
            id: PROVIDER_ID,
            endpoint: server.endpoint + "/v1",
            defaultApi: OPENAI_COMPATIBLE_API_ID,
            allowUnknownModels: false,
            credentials: {
              resolve: async () => ({ apiKey: CONTENT_MARKERS[3] ?? "offline-fixture" }),
            },
          },
        ],
        adapters: [createOpenAICompatibleApiAdapter()],
      });

      await ai.gateway.complete(await request("work commentary: clean"));
      await ai.gateway.complete(
        await request("work commentary: dirty", [runtimeSnapshot("work commentary: clean")]),
      );

      const firstBody = server.requests[0]?.body;
      const secondBody = server.requests[1]?.body;
      expect(server.requests.length).toBe(2);
      if (firstBody === undefined || secondBody === undefined) {
        throw new Error("The local provider fixture did not capture both requests.");
      }

      const difference = firstDifference(firstBody, secondBody);
      const firstMessages = firstBody["messages"] as readonly unknown[];
      const secondMessages = secondBody["messages"] as readonly unknown[];
      expect(
        JSON.stringify(secondMessages.slice(0, firstMessages.length)) ===
          JSON.stringify(firstMessages),
      ).toBe(true);
      expect(difference).toEqual({
        section: "messages",
        path: "messages",
        arrayIndex: firstMessages.length,
        category: "ARRAY_LENGTH_CHANGED",
      });
      expect(firstBody["reasoning_effort"]).toBe("low");
      expect(firstBody["temperature"]).toBe(0.25);
      expect(firstBody["max_tokens"]).toBe(512);
      expect(JSON.stringify(firstBody["tools"]) === JSON.stringify(secondBody["tools"])).toBe(true);
      expect(
        JSON.stringify(withoutKeys(firstBody, ["messages"])) ===
          JSON.stringify(withoutKeys(secondBody, ["messages"])),
      ).toBe(true);

      const diagnostic = JSON.stringify(difference);
      for (const marker of CONTENT_MARKERS) {
        expect(diagnostic.includes(marker)).toBe(false);
      }

      const pathCases: readonly {
        readonly section: SafeFirstDifference["section"];
        readonly path: string;
        readonly mutate: (body: Record<string, unknown>) => void;
      }[] = [
        {
          section: "messages",
          path: "messages[1].content",
          mutate(body) {
            (body["messages"] as Record<string, unknown>[])[1]!["content"] = "changed";
          },
        },
        {
          section: "messages",
          path: "messages[2].tool_calls[0].function.arguments",
          mutate(body) {
            const messages = body["messages"] as Record<string, unknown>[];
            const assistant = messages[2] as Record<string, unknown>;
            const toolCalls = assistant["tool_calls"] as Record<string, unknown>[];
            const toolCall = toolCalls[0] as Record<string, unknown>;
            (toolCall["function"] as Record<string, unknown>)["arguments"] = "changed";
          },
        },
        {
          section: "tools",
          path: "tools[0].function.description",
          mutate(body) {
            const tools = body["tools"] as Record<string, unknown>[];
            (tools[0]!["function"] as Record<string, unknown>)["description"] = "changed";
          },
        },
        {
          section: "settings",
          path: "settings.reasoning_effort",
          mutate(body) {
            body["reasoning_effort"] = "medium";
          },
        },
        {
          section: "settings",
          path: "settings.temperature",
          mutate(body) {
            body["temperature"] = 0.5;
          },
        },
        {
          section: "settings",
          path: "settings.max_tokens",
          mutate(body) {
            body["max_tokens"] = 256;
          },
        },
        {
          section: "settings",
          path: "settings.top_p",
          mutate(body) {
            body["top_p"] = 0.8;
          },
        },
      ];

      for (const pathCase of pathCases) {
        const variant = JSON.parse(JSON.stringify(firstBody)) as Record<string, unknown>;
        pathCase.mutate(variant);
        const pathDiagnostic = firstDifference(firstBody, variant);
        expect(pathDiagnostic?.section).toBe(pathCase.section);
        expect(pathDiagnostic?.path).toBe(pathCase.path);
        expect(
          pathDiagnostic !== undefined &&
            Object.keys(pathDiagnostic).every((key) =>
              ["section", "path", "arrayIndex", "category"].includes(key),
            ),
        ).toBe(true);
        const safeOutput = JSON.stringify(pathDiagnostic);
        for (const marker of CONTENT_MARKERS) {
          expect(safeOutput.includes(marker)).toBe(false);
        }
      }
    } finally {
      await server.close();
    }
  });
});
