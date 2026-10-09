import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function runPtySmoke({
  productRoot,
  executable = process.execPath,
  env = process.env,
}) {
  const runtimeEntry = pathToFileURL(
    join(productRoot, "node_modules", "@caelush", "runtime", "dist", "index.js"),
  ).href;
  const nodePtyEntry = pathToFileURL(
    join(productRoot, "node_modules", "node-pty", "lib", "index.js"),
  ).href;
  const [{ createPtyProcessAdapter }, nodePty] = await Promise.all([
    import(runtimeEntry),
    import(nodePtyEntry),
  ]);
  if (typeof nodePty.spawn !== "function") throw new Error("PTY_LOAD_FAILED");

  const echo = await createPtyProcessAdapter({
    launch: {
      executable,
      args: [
        "-e",
        "process.stdout.write('READY\\r\\n'); process.stdin.setEncoding('utf8'); process.stdin.once('data', value => { process.stdout.write('ECHO:' + value); process.exit(0); });",
      ],
    },
    cwd: productRoot,
    env,
  });
  let normalExit;
  try {
    const echoOutput = collectOutput(echo);
    await waitForText(echoOutput, "READY", 5000);
    await echo.write("PTY-UTF8-终端✓\r");
    await waitForText(echoOutput, "ECHO:PTY-UTF8-终端✓", 5000);
    normalExit = await waitForExit(echo, 5000);
  } finally {
    await echo.close();
  }
  if (normalExit.exitCode !== 0) throw new Error("PTY_NORMAL_EXIT_FAILED");

  const longRunning = await createPtyProcessAdapter({
    launch: {
      executable,
      args: ["-e", "process.stdout.write('READY\\r\\n'); setInterval(() => {}, 1000);"],
    },
    cwd: productRoot,
    env,
  });
  let cancelledExit;
  try {
    const cancelOutput = collectOutput(longRunning);
    await waitForText(cancelOutput, "READY", 5000);
    const termination = waitForExit(longRunning, 5000);
    await longRunning.close();
    cancelledExit = await termination;
  } finally {
    await longRunning.close();
  }
  if (cancelledExit.exitCode === undefined && cancelledExit.signal === undefined) {
    throw new Error("PTY_CANCELLED_WITHOUT_EXIT");
  }

  return {
    PTY_LOAD_SUCCESS: true,
    PTY_SPAWN_SUCCESS: true,
    PTY_IO_SUCCESS: true,
    PTY_TERMINATION_SUCCESS: true,
    normalExitCode: normalExit.exitCode,
    cancelledExitCode: cancelledExit.exitCode ?? null,
    cancelledSignal: cancelledExit.signal ?? null,
    utf8Echo: "PTY-UTF8-终端✓",
  };
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (currentFile.toLowerCase() === invokedFile.toLowerCase()) {
  try {
    const result = await runPtySmoke({ productRoot: process.argv[2] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch {
    process.stderr.write("PTY_SMOKE_FAILED\n");
    process.exit(1);
  }
}

function collectOutput(adapter) {
  const state = { text: "", waiters: [] };
  adapter.onOutput((event) => {
    state.text += event.text;
    for (const waiter of [...state.waiters]) {
      if (state.text.includes(waiter.needle)) {
        state.waiters.splice(state.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  });
  return state;
}

async function waitForText(state, needle, timeoutMs) {
  if (state.text.includes(needle)) return;
  let timer;
  try {
    await Promise.race([
      new Promise((resolve) => state.waiters.push({ needle, resolve })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PTY_OUTPUT_TIMEOUT:${needle}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    state.waiters = state.waiters.filter((waiter) => waiter.needle !== needle);
  }
}

function waitForExit(adapter, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("PTY_EXIT_TIMEOUT"));
    }, timeoutMs);
    adapter.onExit((exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exit);
    });
    adapter.onError((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}
