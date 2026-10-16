import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build as viteBuild, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { parseWebLaunchContext } from "../src/host/bootstrap.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const indexPath = new URL("../index.html", import.meta.url);
const configPath = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

function expectThemeBootstrapOrder(html: string, base: "/" | "/agent/") {
  const script = html.indexOf(`${base}assets/appearance-bootstrap.js`);
  const stylesheet = html.indexOf(`${base}assets/appearance-bootstrap.css`);
  const moduleTag = [...html.matchAll(/<script\s+type="module"[^>]*>/gu)]
    .map((match) => match[0])
    .find((tag) => tag.includes(`${base}src/main.tsx`) || tag.includes(`${base}assets/`));
  const module = moduleTag === undefined ? -1 : html.indexOf(moduleTag);
  const root = html.indexOf('<div id="root">');

  expect(script).toBeGreaterThanOrEqual(0);
  expect(stylesheet).toBeGreaterThan(script);
  expect(module).toBeGreaterThan(script);
  expect(root).toBeGreaterThan(stylesheet);
}

describe("Vite development bootstrap context", () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("keeps first-paint resources below the Web static host's asset route", () => {
    const html = readFileSync(indexPath, "utf8");

    expect(existsSync(new URL("../public/assets/appearance-bootstrap.js", import.meta.url))).toBe(
      true,
    );
    expect(existsSync(new URL("../public/assets/appearance-bootstrap.css", import.meta.url))).toBe(
      true,
    );
    expect(html).toContain('src="/assets/appearance-bootstrap.js"');
    expect(html).toContain('href="/assets/appearance-bootstrap.css"');
  });

  it("serves an empty valid launch context in the development HTML", async () => {
    server = await createServer({
      configFile: configPath,
      root: webRoot,
      server: { middlewareMode: true, hmr: false },
    });

    const source = await readFile(indexPath, "utf8");
    const html = await server.transformIndexHtml("/", source);
    const bootstrap = html.match(
      /<script id="caelush-bootstrap" type="application\/json">([\s\S]*?)<\/script>/u,
    )?.[1];

    expect(bootstrap).toBeDefined();
    await expect(parseWebLaunchContext(bootstrap?.trim())).resolves.toEqual({});
    expect(html).not.toContain("__CAELUSH_BOOTSTRAP__");
    expectThemeBootstrapOrder(html, "/");
  });
});

describe("Vite Desktop build bootstrap context", () => {
  it("emits a valid empty bootstrap object at the /agent/ base path", async () => {
    const result = await viteBuild({
      configFile: configPath,
      root: webRoot,
      mode: "desktop",
      build: { write: false },
      logLevel: "silent",
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const indexHtml = outputs.find(
      (item) => item.type === "asset" && item.fileName === "index.html",
    );
    if (indexHtml?.type !== "asset" || typeof indexHtml.source !== "string") {
      throw new Error("The Desktop Vite build did not emit index.html.");
    }
    const bootstrap = indexHtml.source.match(
      /<script id="caelush-bootstrap" type="application\/json">([\s\S]*?)<\/script>/u,
    )?.[1];

    expect(indexHtml.source).toContain("/agent/assets/");
    expect(indexHtml.source).toContain("/agent/assets/appearance-bootstrap.js");
    expect(indexHtml.source).toContain("/agent/assets/appearance-bootstrap.css");
    // Desktop mode has no runtime static host, so Vite replaces its empty context marker.
    expect(indexHtml.source).not.toContain("__CAELUSH_BOOTSTRAP__");
    expectThemeBootstrapOrder(indexHtml.source, "/agent/");
    await expect(parseWebLaunchContext(bootstrap?.trim())).resolves.toEqual({});
  });

  it("emits the web bootstrap and critical theme CSS before the entry module", async () => {
    const result = await viteBuild({
      configFile: configPath,
      root: webRoot,
      build: { write: false },
      logLevel: "silent",
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const indexHtml = outputs.find(
      (item) => item.type === "asset" && item.fileName === "index.html",
    );
    if (indexHtml?.type !== "asset" || typeof indexHtml.source !== "string") {
      throw new Error("The Web Vite build did not emit index.html.");
    }

    expect(indexHtml.source).toContain("/assets/appearance-bootstrap.js");
    expect(indexHtml.source).toContain("/assets/appearance-bootstrap.css");
    expectThemeBootstrapOrder(indexHtml.source, "/");
    // The daemon Web static host injects this marker per request; keep its runtime contract.
    expect(indexHtml.source).toContain("__CAELUSH_BOOTSTRAP__");
  });
});
