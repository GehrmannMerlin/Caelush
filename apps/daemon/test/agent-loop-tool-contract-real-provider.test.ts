import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = "scripts/agent-loop-tool-contract-audit.mjs";

describe("real DeepSeek Agent Loop product-entry audit", () => {
  it("reports a safe blocked status when live credentials are absent", async () => {
    if (process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY.length > 0) return;
    const result = await run(process.execPath, [script], { cwd: process.cwd() });
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      reason?: string;
      env?: Record<string, string>;
    };
    expect(parsed.status).toBe("SKIPPED");
    expect(parsed.reason).toBe("DEEPSEEK_API_KEY_MISSING");
    expect(Object.values(parsed.env ?? {}).every((value) => ["PRESENT", "MISSING"].includes(value))).toBe(true);
    expect(result.stdout).not.toContain(process.env.DEEPSEEK_API_KEY ?? "__missing-secret-sentinel__");
  });

  it("keeps the live path bounded and safe when credentials are configured", async () => {
    if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.length === 0) return;
    const result = await run(process.execPath, [script], { cwd: process.cwd() });
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(process.env.DEEPSEEK_API_KEY);
    expect(result.stdout).not.toMatch(/private prompt|private output|hidden reasoning|Bearer\s+/iu);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      results?: Array<{ llmTurns?: number }>;
    };
    expect(parsed.status).toBe("COMPLETED");
    for (const item of parsed.results ?? []) expect(item.llmTurns ?? 0).toBeLessThanOrEqual(12);
  }, 180_000);
});
