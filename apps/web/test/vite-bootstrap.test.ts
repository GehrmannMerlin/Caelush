import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build as viteBuild, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { parseWebLaunchContext } from "../src/host/bootstrap.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const indexPath = new URL("../index.html", import.meta.url);
const configPath = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

describe("Vite development bootstrap context", () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
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
    expect(indexHtml.source).not.toContain("__CAELUSH_BOOTSTRAP__");
    await expect(parseWebLaunchContext(bootstrap?.trim())).resolves.toEqual({});
  });
});
