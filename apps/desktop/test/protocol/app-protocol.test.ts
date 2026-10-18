import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { protocol } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerAppProtocol } from "../../src/main/protocol/app-protocol.js";

vi.mock("electron", () => ({ protocol: { handle: vi.fn() } }));

describe("Desktop workbench document policy", () => {
  it("allows local Blob image previews while retaining script and connection restrictions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "caelush-app-policy-"));
    try {
      await writeFile(path.join(root, "index.html"), "<!doctype html><div>Workbench</div>");
      registerAppProtocol({
        rendererRoot: root,
        agentRoot: root,
        isAgentAvailable: () => true,
        localProxy: {} as never,
      });
      const handler = vi
        .mocked(protocol.handle)
        .mock.calls.find(([scheme]) => scheme === "caelush-app")?.[1];
      expect(handler).toBeDefined();
      const response = await handler!(new Request("caelush-app://app/agent/") as never);
      expect(response.status).toBe(200);
      const policy = response.headers.get("content-security-policy");
      expect(policy).toContain("img-src 'self' data: blob:");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("connect-src 'self'");
      expect(policy).toContain("object-src 'none'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
