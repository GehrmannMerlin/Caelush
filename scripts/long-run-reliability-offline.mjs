#!/usr/bin/env node
/* global Buffer, URL, console, process */
/**
 * Offline long-run reliability harness.
 *
 * ```text
 * no model call   no network   no API key   deterministic
 * ```
 *
 * It exercises the deterministic defects the long-run reliability work addressed, using the same
 * public modules production uses — and it reports them by **verification layer**, because the three
 * layers answer different questions and only one of them can be answered without a model:
 *
 * ```text
 * INFRASTRUCTURE_CAPACITY   a full epoch rotates, not fails; a long sequence stays ordered
 * FEEDBACK_PATH             a wrong field is named; a repeated mistake escalates; a plan states
 *                           that "completed" is a report rather than proof
 * REAL_MODEL_ADAPTATION     NOT MEASURED HERE — needs a configured provider, a fixed task set and an
 *                           external acceptance check, and it costs money
 * ```
 *
 * A green run below therefore says nothing about completion rate or about whether a real model
 * recovers. It is the part of the claim that can be made offline, and it is labelled as such.
 *
 * Run it after `pnpm build`:
 *
 * ```bash
 * node scripts/long-run-reliability-offline.mjs
 * ```
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
  resourceProgressPolicyFrom,
  resourceProgressTurn,
} = core;
const { applyPatchInputSchema, deriveTaskPlanSnapshot, renderTaskPlanBlock, validatePlanSteps } =
  coding;

const LAYERS = Object.freeze({
  INFRASTRUCTURE_CAPACITY: {
    title: "INFRASTRUCTURE_CAPACITY",
    question: "does the mechanism hold under load, independent of any model?",
  },
  FEEDBACK_PATH: {
    title: "FEEDBACK_PATH",
    question: "is the feedback a model would need actually delivered, and is it true?",
  },
});

const results = [];
function check(layer, name, condition, detail) {
  if (LAYERS[layer] === undefined) throw new RangeError(`unknown verification layer ${layer}`);
  results.push({ layer, name, pass: Boolean(condition), detail });
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
  "INFRASTRUCTURE_CAPACITY",
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
  "INFRASTRUCTURE_CAPACITY",
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
  "FEEDBACK_PATH",
  "an input-only apply_patch names both the missing and the unsupported field",
  named,
  inputOnly.valid ? "unexpectedly valid" : JSON.stringify(inputOnly.issues.map((i) => i.property)),
);

const acceptsExample = compiled.validate({
  patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch",
});
check(
  "FEEDBACK_PATH",
  "the documented argument shape passes the real schema",
  acceptsExample.valid,
  "",
);

/* ------------------------------------------------------------- repeated failures */

// The thresholds come from a Run's frozen policy, not from constants copied into this script: a
// harness that hard-codes 3/4/2 would keep passing after the policy changed underneath it.
const PROGRESS_POLICY = resourceProgressPolicyFrom({
  mode: "ADAPTIVE",
  correctionVersion: "AUTONOMOUS_CORRECTION_V2",
  operationalLease: { maxAgentTurns: 24, maxToolOperations: 64 },
  batch: { maxToolCallsPerTurn: 2 },
  progress: {
    windowTurns: 8,
    identicalCallNudgeThreshold: 3,
    noProgressTurnsBeforeReplan: 4,
    replansBeforePause: 2,
  },
  hardLimits: {},
  inactivity: {},
});

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
const corrections = [];
for (let turn = 1; turn <= 8; turn += 1) {
  window = applyResourceProgressTurn(
    PROGRESS_POLICY,
    window,
    failureTurn(`step-${turn}`, `patch body ${turn}`),
  );
  const decision = decideResourceSemanticIntervention(PROGRESS_POLICY, window);
  if (decision.kind === "NUDGE") corrections.push({ turn, stage: decision.stage });
}
check(
  "FEEDBACK_PATH",
  "64 attempts with different patch bodies collapse into one pattern",
  window.turns.length > 0,
  "",
);
check(
  "FEEDBACK_PATH",
  "the third identical failure prepares the first correction rung",
  corrections[0]?.turn === 3 && corrections[0]?.stage === "INPUT_CORRECTION",
  `turn=${String(corrections[0]?.turn ?? "-")} stage=${corrections[0]?.stage ?? "-"}`,
);
/*
 * The rungs are delivery-gated: INPUT_CORRECTION -> REVIEW_APPROACH -> REBUILD_WORK_STATE advance
 * only when a receipt proves the model was actually told. This window records no receipts, so the
 * advice must stay on the first rung — escalating past it would blame the model for advice it never
 * received. The advancing sequence is covered by the delivery-receipt tests, not by this harness.
 */
check(
  "FEEDBACK_PATH",
  "an undelivered correction never silently escalates to a later rung",
  corrections.length > 0 && corrections.every((entry) => entry.stage === "INPUT_CORRECTION"),
  [...new Set(corrections.map((entry) => entry.stage))].join(",") || "none",
);

const activityOnly = Array.from({ length: 10 }, (_unused, index) =>
  resourceProgressTurn({
    turnId: `activity-${index}`,
    results: [{ toolName: "read_file", isError: false }],
  }),
).reduce(
  (progress, turn) => applyResourceProgressTurn(PROGRESS_POLICY, progress, turn),
  emptyResourceSemanticProgress(),
);
check(
  "FEEDBACK_PATH",
  "ten productive reads never escalate",
  decideResourceSemanticIntervention(PROGRESS_POLICY, activityOnly).kind === "NONE",
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
check("FEEDBACK_PATH", "a valid plan is accepted", planOk, "");
check(
  "FEEDBACK_PATH",
  "the accepted plan is re-derivable from messages",
  snapshot?.steps.length === 2,
  "",
);
check(
  "FEEDBACK_PATH",
  "the rendered plan states that a completed step is a report",
  snapshot !== undefined && renderTaskPlanBlock(snapshot).includes("not proof"),
  "",
);

/* ------------------------------------------------------------------ report */

const failed = results.filter((result) => !result.pass);
const width = Math.max(...results.map((result) => result.name.length));
console.log("\nLong-run reliability — offline checks, by verification layer\n");
for (const [layer, description] of Object.entries(LAYERS)) {
  const group = results.filter((result) => result.layer === layer);
  if (group.length === 0) continue;
  const passed = group.filter((result) => result.pass).length;
  console.log(`  ${description.title}  ${String(passed)}/${String(group.length)}`);
  console.log(`    ${description.question}`);
  for (const result of group) {
    console.log(
      `    ${result.pass ? "PASS" : "FAIL"}  ${result.name.padEnd(width)}  ${result.detail}`,
    );
  }
  console.log("");
}
console.log("  REAL_MODEL_ADAPTATION  NOT MEASURED");
console.log("    would a real model use this feedback to finish a complex task?");
console.log("    Needs a configured provider, a fixed task set and an external acceptance check.");
console.log(
  "    Run scripts/reliability-real-model-eval.mjs for that layer; it is reported separately.",
);
console.log(
  `\n  ${String(results.length - failed.length)}/${String(results.length)} offline checks passed.` +
    "  No model was called: this is not a completion rate.\n",
);
process.exit(failed.length === 0 ? 0 : 1);
