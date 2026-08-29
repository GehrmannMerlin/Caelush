import { describe, expect, it } from "vitest";
import * as runtime from "../src/index.js";

describe("@caelush/runtime exec public API", () => {
  it("exports the provider-independent execution contracts and implementations", () => {
    expect(runtime.LocalRuntimeExecService).toBeDefined();
    expect(runtime.LocalProcessManager).toBeDefined();
    expect(runtime.LocalShellResolver).toBeDefined();
    expect(runtime.TerminalOutputDecoder).toBeDefined();
    expect(runtime.HeadTailOutputBuffer).toBeDefined();
    expect(runtime.MAX_EXEC_MODEL_OUTPUT_BYTES).toBe(48 * 1024);
  });
});
