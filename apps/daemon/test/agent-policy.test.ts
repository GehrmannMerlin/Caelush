import { CODING_EXECUTION_DISCIPLINE } from "@caelush/coding-agent";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_SYSTEM_PROMPT,
  DEFAULT_CORE_AGENT_POLICY,
} from "../src/daemon-composition.js";

describe("default Core Agent Policy", () => {
  it("covers safe workspace navigation, evidence, tool errors, and stopping semantics", () => {
    expect(DEFAULT_BASE_SYSTEM_PROMPT).toBe(DEFAULT_CORE_AGENT_POLICY);
    for (const phrase of [
      "active workspace",
      "use '.'",
      "evidence before",
      "Tool errors",
      "avoid repeating",
      "inapplicable tool",
      "mutation tools for read-only",
      "list_directory for immediate children",
      "exec_command for tests",
      "write_stdin only for a session",
      "stop_process to end a long-running session",
      "never use it to terminate a process with taskkill",
      "Stop when",
      "blockers",
      "chain-of-thought",
    ]) {
      expect(DEFAULT_CORE_AGENT_POLICY).toContain(phrase);
    }
  });

  it("carries the coding execution discipline exactly once", () => {
    // One canonical policy: a second copy would let the two drift, and a missing one would leave the
    // plan Tool with guidance but no discipline for when to use it.
    const occurrences = DEFAULT_CORE_AGENT_POLICY.split(CODING_EXECUTION_DISCIPLINE).length - 1;
    expect(occurrences).toBe(1);
  });

  it("states the behaviour the reliability fix depends on", () => {
    // These are the sentences that make the rest of the change coherent: without them the plan Tool is
    // available but unused, corrections are not applied, and a ticked checklist is mistaken for a
    // finished task.
    for (const phrase of [
      "verifiable milestones",
      "say briefly why it changed",
      "Correct ordinary Tool errors yourself",
      "Do not ask the user to confirm an ordinary re-plan",
      "unresolved",
      "single next action",
      "Do not claim a check passed",
      "do not declare the task complete merely because every plan step is marked done",
      "If the plan Tool is unavailable",
      "A simple question does not need a plan",
      "must stop at the design",
    ]) {
      expect(CODING_EXECUTION_DISCIPLINE).toContain(phrase);
    }
  });
});
