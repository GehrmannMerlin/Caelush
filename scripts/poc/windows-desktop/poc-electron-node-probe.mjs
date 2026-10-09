import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runPtySmoke } from "./pty-smoke.mjs";

const productRoot = process.argv[2];
if (typeof productRoot !== "string" || productRoot.length === 0) {
  process.exitCode = 2;
} else {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE electron_probe (value TEXT NOT NULL); INSERT INTO electron_probe VALUES ('ok')",
  );
  const sqliteProbe = db.prepare("SELECT value FROM electron_probe").get();
  db.close();
  let pty;
  try {
    const runtimeEntry = pathToFileURL(
      join(productRoot, "node_modules", "@caelush", "runtime", "dist", "index.js"),
    ).href;
    await import(runtimeEntry);
    const nodePtyEntry = pathToFileURL(
      join(productRoot, "node_modules", "node-pty", "lib", "index.js"),
    ).href;
    const nativePty = await import(nodePtyEntry);
    if (typeof nativePty.spawn !== "function") throw new Error("PTY_LOAD_FAILED");
    const ptyExecutable = process.env.CAELUSH_POC_NODE_EXECUTABLE || process.execPath;
    pty = {
      status: "PASS",
      nativeModuleLoadedByElectron: true,
      childRuntimeExecutable:
        ptyExecutable === process.execPath ? "electron-executable" : "bundled-node-executable",
      ...(await runPtySmoke({ productRoot, executable: ptyExecutable, env: process.env })),
    };
  } catch (error) {
    pty = {
      status: "FAIL",
      reason: typeof error?.code === "string" ? error.code : "PTY_EMBEDDED_ABI_OR_RUNTIME_ERROR",
      diagnostic:
        typeof error?.message === "string"
          ? error.message.replace(/[A-Za-z]:\\[^\r\n]*/g, "<path>").slice(0, 500)
          : "Native PTY loading failed without a diagnostic message.",
    };
  }
  try {
    process.stdout.write(
      `${JSON.stringify({
        status: pty.status,
        electronVersion: process.versions.electron ?? null,
        nodeVersion: process.versions.node,
        modulesAbi: process.versions.modules,
        napi: process.versions.napi,
        sqliteVersion: process.versions.sqlite ?? null,
        esm: true,
        sqlite: sqliteProbe?.value === "ok",
        pty,
      })}\n`,
    );
    process.exit(0);
  } catch {
    process.stderr.write("ELECTRON_NODE_PROBE_FAILED\n");
    process.exit(1);
  }
}
