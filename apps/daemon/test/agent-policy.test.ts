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
      "Stop when",
      "blockers",
      "chain-of-thought",
    ]) {
      expect(DEFAULT_CORE_AGENT_POLICY).toContain(phrase);
    }
  });
});
