import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDaemonApp } from "../src/index.js";
import { createWorkspaceRef } from "../src/web/workspace-launch-context.js";

const info = {
  apiVersion: "v1" as const,
  protocolVersion: 1 as const,
  daemonVersion: "0.1.0",
  capabilities: {
    runExecution: true as const,
    runRecovery: true as const,
    cancellation: true as const,
    approvals: true as const,
    sseReplay: true as const,
  },
  runtimeKinds: ["local"] as ["local"],
  configuredProviders: [],
  defaultRunConfiguration: {
    runtime: { id: "local", kind: "local" },
    permissionProfile: "PROJECT_ACCESS" as const,
    approvalPolicy: "DANGEROUS_ONLY" as const,
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 10_000 },
  },
};

async function createWebFixture(): Promise<{ readonly root: string; readonly workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "caelush-web-host-"));
  const workspace = await mkdtemp(join(tmpdir(), "caelush-web-workspace-"));
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><script id="caelush-bootstrap" type="application/json">__CAELUSH_BOOTSTRAP__</script><div id="root">shell</div>',
  );
  await writeFile(join(root, "assets", "app-abc123.js"), "console.log('web');");
  await writeFile(join(root, "outside.txt"), "outside");
  return { root, workspace };
}

function buildApp(fixture: { readonly root: string; readonly workspace: string }) {
  return buildDaemonApp({
    sessions: {} as never,
    runs: {} as never,
    eventBus: {} as never,
    config: { host: "127.0.0.1", port: 43120, sseHeartbeatIntervalMs: 15_000 },
    info,
    web: {
      buildRoot: fixture.root,
      workspace: createWorkspaceRef(fixture.workspace),
    },
  });
}

describe("daemon production Web static host", () => {
  it("serves index with launch context and browser security headers", async () => {
    const fixture = await createWebFixture();
    const app = buildApp(fixture);
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "127.0.0.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.body).toContain('"workspace"');
    expect(response.body).not.toContain("__CAELUSH_BOOTSTRAP__");

    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.workspace, { recursive: true, force: true });
  });

  it("serves assets with immutable caching and supports SPA fallback", async () => {
    const fixture = await createWebFixture();
    const app = buildApp(fixture);
    const asset = await app.inject({
      method: "GET",
      url: "/assets/app-abc123.js",
      headers: { host: "127.0.0.1" },
    });
    const route = await app.inject({
      method: "GET",
      url: "/host/ready",
      headers: { host: "127.0.0.1" },
    });

    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('id="caelush-bootstrap"');

    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.workspace, { recursive: true, force: true });
  });

  it("keeps API routes and invalid API paths outside the SPA fallback", async () => {
    const fixture = await createWebFixture();
    const app = buildApp(fixture);
    const health = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "127.0.0.1" },
    });
    const infoResponse = await app.inject({
      method: "GET",
      url: "/api/v1/info",
      headers: { host: "127.0.0.1" },
    });
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/not-a-route",
      headers: { host: "127.0.0.1" },
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ service: "caelush-daemon", protocolVersion: 1 });
    expect(infoResponse.statusCode).toBe(200);
    expect(infoResponse.json()).toMatchObject({ daemonVersion: "0.1.0", protocolVersion: 1 });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers["content-type"]).toContain("application/json");
    expect(unknown.body).not.toContain("caelush-bootstrap");

    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.workspace, { recursive: true, force: true });
  });

  it("rejects traversal and non-loopback requests without exposing files", async () => {
    const fixture = await createWebFixture();
    const app = buildApp(fixture);
    const traversal = await app.inject({
      method: "GET",
      url: "/assets/..%2Foutside.txt",
      headers: { host: "127.0.0.1" },
    });
    const publicRequest = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "attacker.example.com" },
    });

    expect(traversal.statusCode).toBe(404);
    expect(traversal.body).not.toContain("outside");
    expect(publicRequest.statusCode).toBe(403);

    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.workspace, { recursive: true, force: true });
  });

  it("rejects an asset symlink that resolves outside the build root", async () => {
    const fixture = await createWebFixture();
    const outside = await mkdtemp(join(tmpdir(), "caelush-web-outside-"));
    await writeFile(join(outside, "secret.js"), "outside-secret");
    await symlink(outside, join(fixture.root, "assets", "linked"), "junction");
    const app = buildApp(fixture);
    const response = await app.inject({
      method: "GET",
      url: "/assets/linked/secret.js",
      headers: { host: "127.0.0.1" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("outside-secret");

    await app.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects an index without the trusted bootstrap marker", async () => {
    const fixture = await createWebFixture();
    await writeFile(join(fixture.root, "index.html"), "<html>missing marker</html>");
    expect(() => buildApp(fixture)).toThrow(
      "The Web index asset is missing its launch context marker.",
    );
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.workspace, { recursive: true, force: true });
  });
});

describe("workspace launch identity", () => {
  it("keeps the same identity for equivalent paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "caelush-workspace-identity-"));
    const first = createWorkspaceRef(workspace);
    const second = createWorkspaceRef(join(workspace, "."));

    expect(second).toEqual(first);
    expect(first.id).toMatch(/^wsp_[0-9a-f-]{36}$/);

    await rm(workspace, { recursive: true, force: true });
  });
});
