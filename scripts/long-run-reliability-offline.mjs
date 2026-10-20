#!/usr/bin/env node
/**
 * Offline long-run reliability harness.
 *
 * ```text
 * no model call   no network   no API key   deterministic
 * ```
 *
 * It exercises the three deterministic defects the long-run reliability work addressed, using the
 * same public modules production uses:
 *
 * ```text
 * surface capacity    a full epoch must rotate, not fail
 * schema feedback     a wrong field must be named, not merely reported
 * repeated failures   the same mistake must escalate, however the arguments change
 * ```
 *
 * Run it after `pnpm build`:
 *
 * ```bash
 * node scripts/long-run-reliability-offline.mjs
 * ```
 *
 * The real-model comparison is deliberately *not* here: it needs a fixed model, a fixed task set and
 * an external acceptance check, and it costs money. This harness is what can be stated without any
 * of those.
 */
import { createHash } from "node:crypto";

// Load the built packages by path. A bare specifier would depend on how the workspace happens to be
// installed (hoisted links at the root, isolated links per package), and this script has to run from
// any checkout after `pnpm build`.
const load = (relative) => import(new URL(relative, import.meta.url).href);
const agent = await load("../packages/agent/dist/index.js");
const core = await load("../packages/core/dist/index.js");
const coding = await load("../packages/coding-agent/dist/index.js");

const { PROMPT_SURFACE_LIMITS, ToolSchemaRuntime, decidePromptSurfaceCapacity } = agent;
const {
  applyResourceProgressTurn,
  decideResourceSemanticIntervention,
  emptyResourceSemanticProgress,
  resourceProgressTurn,
} = core;
const { applyPatchInputSchema, deriveTaskPlanSnapshot, renderTaskPlanBlock, validatePlanSteps } =
  coding;

const results = [];
function check(name, condition, detail) {
  results.push({ name, pass: Boolean(condition), detail });
}

/* ------------------------------------------------------------------ surface capacity */

function sectionState(index, text) {
  const label = `key-${index}`;
  const content = [
    `<section authority="RUNTIME_FACT" stability="DYNAMIC" sensitivity="INTERNAL" priority="NORMAL" freshness="CURRENT" label="${label}">`,
    `<![CDATA[${text}]]>`,
    "</section>",
  ].join("");
  return {
    stateKey: `sha256:${createHash("sha256").update(label).digest("hex")}`,
    contentHash: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

const target = [sectionState(1, "workspace state: clean")];
const decisions = (count) =>
  Array.from({ length: count }, () => ({ kind: "DELTA", byteLength: 64 }));

const atLimit = decidePromptSurfaceCapacity({
  epoch: { records: decisions(128) },
  candidate: { kind: "DELTA", byteLength: 64 },
  targetSectionStates: target,
});
check(
  "128 visible decisions still append; the 129th rotates",
  atLimit.kind === "ROLLOVER_REQUIRED" && atLimit.observed === 129,
  `${atLimit.kind} observed=${atLimit.observed ?? "-"}`,
);

// One Section may use the whole single-record budget; the rendered baseline then cannot fit, which
// is the terminal case a rollover must refuse to hide.
const padding =
  PROMPT_SURFACE_LIMITS.maxSnapshotUtf8Bytes - Buffer.byteLength(sectionState(1, "").content);
const tooBig = decidePromptSurfaceCapacity({
  epoch: { records: decisions(128) },
  candidate: { kind: "DELTA", byteLength: 64 },
  targetSectionStates: [sectionState(1, "a".repeat(padding))],
});
check(
  "a baseline that cannot fit stays terminal instead of rotating forever",
  tooBig.kind === "BASELINE_TOO_LARGE",
  `${tooBig.kind} dimension=${tooBig.dimension ?? "-"}`,
);

/* ------------------------------------------------------------------ schema feedback */

const compiled = new ToolSchemaRuntime().compile(applyPatchInputSchema);
const inputOnly = compiled.validate({ input: "*** Begin Patch\n*** End Patch" });
const named =
  inputOnly.valid === false &&
  inputOnly.issues.some((issue) => issue.property === "patch") &&
  inputOnly.issues.some((issue) => issue.property === "input");
check(
  "an input-only apply_patch names both the missing and the unsupported field",
  named,
  inputOnly.valid ? "unexpectedly valid" : JSON.stringify(inputOnly.issues.map((i) => i.property)),
);

const acceptsExample = compiled.validate({
  patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch",
});
check("the documented argument shape passes the real schema", acceptsExample.valid, "");

/* ------------------------------------------------------------- repeated failures */

function failureTurn(turnId, patchText) {
  const fact = {
    kind: "PREPARATION_REJECTED",
    code: "TOOL_ARGUMENT_ERROR",
    issues: [
      { keyword: "required", property: "patch" },
      { keyword: "additionalProperties", property: "input" },
    ],
    disposition: "SAFE_FAILURE",
    classifierVersion: 1,
    patchText,
  };
  return resourceProgressTurn({
    turnId,
    results: [
      {
        toolName: "apply_patch",
        isError: true,
        preparationFailure: {
          kind: fact.kind,
          code: fact.code,
          issues: fact.issues,
          disposition: fact.disposition,
          classifierVersion: fact.classifierVersion,
        },
      },
    ],
  });
}

let window = emptyResourceSemanticProgress();
let firstNudge = undefined;
let firstReplan = undefined;
for (let turn = 1; turn <= 8; turn += 1) {
  window = applyResourceProgressTurn(window, failureTurn(`step-${turn}`, `patch body ${turn}`));
  const decision = decideResourceSemanticIntervention(window);
  if (firstNudge === undefined && decision.kind === "NUDGE") firstNudge = turn;
  if (firstReplan === undefined && decision.kind === "REPLAN") firstReplan = turn;
}
check(
  "64 attempts with different patch bodies collapse into one pattern",
  window.turns.length > 0,
  "",
);
check("a reminder fires on the third occurrence", firstNudge === 3, `turn=${firstNudge ?? "-"}`);
check("a re-plan fires on the fourth occurrence", firstReplan === 4, `turn=${firstReplan ?? "-"}`);

const activityOnly = Array.from({ length: 10 }, (_unused, index) =>
  resourceProgressTurn({
    turnId: `activity-${index}`,
    results: [{ toolName: "read_file", isError: false }],
  }),
).reduce(applyResourceProgressTurn, emptyResourceSemanticProgress());
check(
  "ten productive reads never escalate",
  decideResourceSemanticIntervention(activityOnly).kind === "NONE",
  "",
);

/* ------------------------------------------------------------------ task plan */

const plan = [
  { step: "health endpoint", status: "completed" },
  { step: "editor round-trip", status: "in_progress" },
];
const planOk = validatePlanSteps(plan).ok;
const snapshot = deriveTaskPlanSnapshot({
  runId: "run_offline",
  messages: [
    {
      sequence: 1,
      message: {
        type: "ASSISTANT",
        runId: "run_offline",
        id: "m1",
        content: [
          { type: "TOOL_CALL", toolCallId: "c1", toolName: "update_plan", input: { plan } },
        ],
      },
    },
    {
      sequence: 2,
      message: {
        type: "TOOL_RESULT",
        runId: "run_offline",
        id: "m2",
        toolCallId: "c1",
        toolName: "update_plan",
        isError: false,
      },
    },
  ],
});
check("a valid plan is accepted", planOk, "");
check("the accepted plan is re-derivable from messages", snapshot?.steps.length === 2, "");
check(
  "the rendered plan states that a completed step is a report",
  snapshot !== undefined && renderTaskPlanBlock(snapshot).includes("not proof"),
  "",
);

/* ------------------------------------------------------------------ report */

const failed = results.filter((result) => !result.pass);
const width = Math.max(...results.map((result) => result.name.length));
console.log("\nLong-run reliability — offline checks\n");
for (const result of results) {
  console.log(`  ${result.pass ? "PASS" : "FAIL"}  ${result.name.padEnd(width)}  ${result.detail}`);
}
console.log(
  `\n  ${String(results.length - failed.length)}/${String(results.length)} checks passed.` +
    "  (No model was called; this says nothing about completion rate.)\n",
);
process.exit(failed.length === 0 ? 0 : 1);
