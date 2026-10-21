import type {
  AIAdapterEvent,
  AIConversationMessage,
  AIToolResultMessage,
  ApiAdapter,
  ApiAdapterStreamInput,
  ApiId,
} from "@caelush/ai";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { answer, finish, toolCall } from "./support/ai-fixture.js";
import { createReliabilityFixture, FIXTURE_API } from "./support/reliability-fixture.js";

/**
 * The production argument pipeline, from the model's wire shape to the next model request.
 *
 * ```text
 * assistant tool call            the exact bytes a provider produced
 *   → Preparer raw byte bound
 *   → apply_patch prepareArguments      ({ input } → frozen { patch })
 *   → registration numeric normalizer   (the second hook in the production composition)
 *   → prepared byte bound → schema → fingerprint → Guard/Security → handler
 *   → ToolInvocation + Observation + TOOL_RESULT
 *   → the next provider turn
 * ```
 *
 * The unit tests in `packages/coding-agent` cover one hook at a time; this file is the composition
 * that actually runs in `apps/daemon`. A model sending `{ input }` used to fail the whole Run here,
 * before any invocation existed, which is why "the Tool is registered" and "the Tool's own hook
 * works" were both true while the product still abandoned the task.
 */

const fixtures: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of fixtures.splice(0)) await dispose();
});

function resultText(message: AIToolResultMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * The model-facing Tool result for one call, read from the real request the gateway built.
 *
 * Missing and duplicated results are both hard failures: a result the model never received and a
 * call answered twice are exactly the two ways "the agent saw the tool's feedback" can be false.
 */
function requireToolResult(input: ApiAdapterStreamInput, callId: string): AIToolResultMessage {
  const matches: AIToolResultMessage[] = [];
  for (const message of input.request.messages as readonly AIConversationMessage[]) {
    if (message.role === "tool" && message.toolCallId === callId) matches.push(message);
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Tool result for ${callId}, found ${matches.length}`);
  }
  return matches[0]!;
}

function toolCallIdsOf(messages: readonly AIConversationMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") ids.push(part.toolCallId);
    }
  }
  return ids;
}

function toolResultCallIdsOf(messages: readonly AIConversationMessage[]): string[] {
  return messages
    .filter((message): message is AIToolResultMessage => message.role === "tool")
    .map((message) => message.toolCallId);
}

/** A recorded view of what the fixture model was actually shown, per request. */
interface RequestLog {
  readonly index: number;
  readonly input: ApiAdapterStreamInput;
}

type Script = (log: RequestLog) => readonly AIAdapterEvent[];

class ScriptedAdapter implements ApiAdapter {
  readonly id = FIXTURE_API as ApiId;
  readonly requests: RequestLog[] = [];

  constructor(private readonly script: Script) {}

  async *stream(input: ApiAdapterStreamInput): AsyncGenerator<AIAdapterEvent> {
    const log: RequestLog = { index: this.requests.length + 1, input };
    this.requests.push(log);
    yield* this.script(log);
  }

  requireRequest(index: number): ApiAdapterStreamInput {
    const log = this.requests[index - 1];
    if (log === undefined) throw new Error(`request ${index} never happened`);
    return log.input;
  }
}

const PLAN_SENTINEL = "PATCH_CHAIN_WITNESS: apply the patch, then continue from its result.";

function planTurn(): AIAdapterEvent[] {
  return [
    ...toolCall("plan-witness", "update_plan", {
      planVersion: 2,
      plan: [
        {
          id: "write",
          step: "Create the fixture file through the normal Tool chain.",
          status: "in_progress",
          acceptance: ["The patch applies and the next model turn runs."],
        },
      ],
      execution: {
        goal: "Demonstrate a plan and a patch surviving the production argument pipeline.",
        constraints: [],
        discoveries: [],
        decisions: [],
        unresolved: [],
        nextAction: PLAN_SENTINEL,
      },
    }),
    finish("TOOL_CALLS"),
  ];
}

const SMALL_PATCH = [
  "*** Begin Patch",
  "*** Add File: note.txt",
  "+production-chain-witness",
  "*** End Patch",
].join("\n");

/**
 * A patch that looks like the historical workload without carrying any of it.
 *
 * The original arguments were ~41.7 KB of multi-file TypeScript for a low-code platform. The shape
 * that matters is "large, multi-file, Chinese text, escaped sequences", so this fixture reproduces
 * those properties and nothing about the user's project.
 */
function largeMultiFilePatch(): string {
  const lines = ["*** Begin Patch"];
  for (let file = 0; file < 8; file += 1) {
    lines.push(`*** Add File: packages/schema/src/material-${file}.ts`);
    lines.push(`+// 物料注册表 ${file}：低代码平台的结构化描述。`);
    lines.push(`+export const label${file} = "组件 \\"${file}\\" 的中文标签";`);
    lines.push(`+export const escaped${file} = "\\u4e2d\\n\\t";`);
    for (let entry = 0; entry < 40; entry += 1) {
      lines.push(
        `+export const entry${file}_${entry} = { id: "field-${file}-${entry}", title: "属性 ${entry}", required: ${entry % 2 === 0} } as const;`,
      );
    }
  }
  lines.push("*** End Patch");
  return lines.join("\n");
}

for (const key of ["patch", "input"] as const) {
  it(`carries a {${key}} patch through the production pipeline to the next model turn`, async () => {
    const adapter = new ScriptedAdapter((log) => {
      if (log.index === 1) return planTurn();
      if (log.index === 2) {
        // The accepted plan is durable history, so the request that asks for the patch must see it.
        expect(JSON.stringify(log.input.request.messages)).toContain(PLAN_SENTINEL);
        // And the update_plan result itself must have been delivered, not just persisted.
        expect(requireToolResult(log.input, "plan-witness").isError).toBe(false);
        return [
          ...toolCall("patch-witness", "apply_patch", { [key]: SMALL_PATCH }),
          finish("TOOL_CALLS"),
        ];
      }
      // The turn that must only happen after a real, non-error result for the patch call.
      const patchResult = requireToolResult(log.input, "patch-witness");
      expect(patchResult.isError).toBe(false);
      expect(patchResult.toolName).toBe("apply_patch");
      expect(resultText(patchResult)).toContain("Patch applied");
      return answer("The fixture file was created and the run continued.");
    });
    const fixture = await createReliabilityFixture({ adapter });
    fixtures.push(() => fixture.dispose());

    const result = await fixture.composition.controller.start(fixture.run.id);

    expect(result.run.status).toBe("COMPLETED");
    expect(adapter.requests).toHaveLength(3);
    await expect(readFile(join(fixture.workspacePath, "note.txt"), "utf8")).resolves.toBe(
      "production-chain-witness\n",
    );

    // Exactly one invocation and one observation: the patch ran once.
    const invocations = (await fixture.storage.toolInvocations.listByRun(fixture.run.id)).filter(
      (invocation) => invocation.toolName === "apply_patch",
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe("COMPLETED");
    const observations = await fixture.storage.observations.listByRun(fixture.run.id);
    expect(
      observations.filter(
        (observation) =>
          observation.kind === "TOOL" && observation.toolInvocationId === invocations[0]?.id,
      ),
    ).toHaveLength(1);
    // The durable invocation holds canonical arguments, whichever spelling the model used.
    expect(Object.keys(invocations[0]?.args ?? {})).toEqual(["patch"]);
    // No second Tool call was invented for the same assistant message.
    expect(toolCallIdsOf(adapter.requireRequest(3).request.messages)).toEqual([
      "plan-witness",
      "patch-witness",
    ]);
  }, 30_000);
}

it("applies the historical-scale {input} shape without failing the Run", async () => {
  const patch = largeMultiFilePatch();
  expect(Buffer.byteLength(patch, "utf8")).toBeGreaterThan(30 * 1024);
  expect(Buffer.byteLength(patch, "utf8")).toBeLessThan(256 * 1024);

  const adapter = new ScriptedAdapter((log) => {
    if (log.index === 1) {
      return [...toolCall("bulk-patch", "apply_patch", { input: patch }), finish("TOOL_CALLS")];
    }
    expect(requireToolResult(log.input, "bulk-patch").isError).toBe(false);
    return answer("The multi-file patch was applied.");
  });
  const fixture = await createReliabilityFixture({ adapter });
  fixtures.push(() => fixture.dispose());

  const result = await fixture.composition.controller.start(fixture.run.id);

  expect(result.run.status).toBe("COMPLETED");
  expect(adapter.requests).toHaveLength(2);
  await expect(
    readFile(join(fixture.workspacePath, "packages/schema/src/material-0.ts"), "utf8"),
  ).resolves.toContain("// 物料注册表 0：低代码平台的结构化描述。");
  await expect(
    readFile(join(fixture.workspacePath, "packages/schema/src/material-7.ts"), "utf8"),
  ).resolves.toContain('export const escaped7 = "\\u4e2d\\n\\t";');
  const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
  expect(invocations).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(invocations[0]?.args), "utf8")).toBeGreaterThan(
    30 * 1024,
  );
}, 60_000);

it("returns a rejected patch and the valid call beside it in source order", async () => {
  const adapter = new ScriptedAdapter((log) => {
    if (log.index === 1) {
      // Both keys is ambiguous, so the compatibility hook must decline and the schema must answer.
      const ambiguous = {
        input: "*** Begin Patch\n*** Add File: forbidden.txt\n+nope\n*** End Patch",
        patch: "*** Begin Patch\n*** Add File: forbidden.txt\n+nope\n*** End Patch",
      };
      return [
        ...toolCall("ambiguous-patch", "apply_patch", ambiguous),
        ...toolCall("valid-read", "read_file", { path: "seed.txt" }),
        finish("TOOL_CALLS"),
      ];
    }
    const messages = log.input.request.messages as readonly AIConversationMessage[];
    expect(toolCallIdsOf(messages)).toEqual(["ambiguous-patch", "valid-read"]);

    const rejected = requireToolResult(log.input, "ambiguous-patch");
    expect(rejected.isError).toBe(true);
    // The model is told which field was wrong, not just that something failed.
    expect(resultText(rejected)).toContain("patch");

    const read = requireToolResult(log.input, "valid-read");
    expect(read.isError).toBe(false);
    expect(resultText(read)).toContain("seed-contents");

    // Results follow the assistant's declaration order in the request itself.
    expect(toolResultCallIdsOf(messages)).toEqual(["ambiguous-patch", "valid-read"]);
    return answer("The rejected patch was corrected in the next attempt.");
  });
  const fixture = await createReliabilityFixture({ adapter });
  fixtures.push(() => fixture.dispose());
  await writeFile(join(fixture.workspacePath, "seed.txt"), "seed-contents\n", "utf8");

  const result = await fixture.composition.controller.start(fixture.run.id);

  expect(result.run.status).toBe("COMPLETED");
  expect(adapter.requests).toHaveLength(2);
  // The rejected patch never reached the handler: no file, no invocation.
  await expect(readFile(join(fixture.workspacePath, "forbidden.txt"), "utf8")).rejects.toThrow();
  const invocations = await fixture.storage.toolInvocations.listByRun(fixture.run.id);
  expect(invocations.map((invocation) => invocation.toolName)).toEqual(["read_file"]);
}, 30_000);
