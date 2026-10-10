import { createRequire } from "node:module";
import path from "node:path";

const MAX_CONTROL_BYTES = 32 * 1024;
const MAX_QUEUED_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_CHUNK_BYTES = 8 * 1024;
const require = createRequire(import.meta.url);
const ptyModule = require("node-pty");
const pendingOutput = [];
let pendingBytes = 0;
let inputBuffer = "";
let writing = false;
let pty;
let ptyExited = false;
let shutdownWhenDrained = false;
let failed = false;

process.stdin.on("data", (chunk) => {
  inputBuffer += chunk.toString("utf8");
  if (Buffer.byteLength(inputBuffer, "utf8") > MAX_CONTROL_BYTES) {
    fail("CONTROL_MESSAGE_TOO_LARGE");
    return;
  }
  while (true) {
    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline).replace(/\r$/u, "");
    inputBuffer = inputBuffer.slice(newline + 1);
    handleControl(line);
  }
});
process.stdin.on("end", () => {
  try {
    pty?.kill();
  } catch {
    process.exitCode = 1;
  }
});
process.stdout.on("drain", () => {
  writing = false;
  flushOutput();
});

function handleControl(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_BYTES) {
    fail("CONTROL_MESSAGE_TOO_LARGE");
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail("CONTROL_MESSAGE_INVALID");
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    fail("CONTROL_MESSAGE_INVALID");
    return;
  }
  if (message.type === "start" && pty === undefined) {
    startPty(message);
    return;
  }
  if (pty === undefined || ptyExited) return;
  if (
    message.type === "write" &&
    typeof message.data === "string" &&
    Buffer.byteLength(message.data, "utf8") <= 16 * 1024
  ) {
    pty.write(message.data);
    return;
  }
  if (
    message.type === "resize" &&
    isDimension(message.cols, 20, 500) &&
    isDimension(message.rows, 5, 300)
  ) {
    pty.resize(message.cols, message.rows);
    return;
  }
  if (message.type === "close") {
    pty.kill();
    return;
  }
  fail("CONTROL_MESSAGE_INVALID");
}

function startPty(message) {
  if (
    message.shell !== "WINDOWS_POWERSHELL" ||
    typeof message.cwd !== "string" ||
    !path.win32.isAbsolute(message.cwd) ||
    !isDimension(message.cols, 20, 500) ||
    !isDimension(message.rows, 5, 300)
  ) {
    fail("START_REQUEST_INVALID");
    return;
  }
  const windowsDirectory = process.env.SystemRoot || "C:\\Windows";
  const executable = path.win32.join(
    windowsDirectory,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    pty = ptyModule.spawn(executable, ["-NoLogo", "-NoExit"], {
      name: "xterm-256color",
      cols: message.cols,
      rows: message.rows,
      cwd: message.cwd,
      env: process.env,
      useConpty: true,
      conptyInheritCursor: true,
    });
  } catch {
    fail("PTY_START_FAILED");
    return;
  }
  pty.onData((data) => enqueueOutput(data));
  pty.onExit(({ exitCode, signal }) => {
    ptyExited = true;
    enqueueMessage({
      type: "exit",
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: Number.isInteger(signal) ? String(signal) : null,
    });
    shutdownWhenDrained = true;
    maybeExit();
  });
  enqueueMessage({ type: "ready" });
}

function enqueueOutput(value) {
  for (const chunk of splitUtf8(value, MAX_OUTPUT_CHUNK_BYTES))
    enqueueMessage({ type: "output", data: chunk });
}

function enqueueMessage(value) {
  if (failed && value.type !== "error") return;
  const line = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (pendingBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) {
    fail("OUTPUT_BACKPRESSURE");
    return;
  }
  pendingOutput.push({ line, bytes });
  pendingBytes += bytes;
  flushOutput();
}

function flushOutput() {
  if (writing) return;
  while (pendingOutput.length > 0) {
    const next = pendingOutput.shift();
    pendingBytes -= next.bytes;
    if (!process.stdout.write(next.line)) {
      writing = true;
      break;
    }
  }
  maybeExit();
}

function fail(code) {
  if (failed) return;
  failed = true;
  pendingOutput.length = 0;
  pendingBytes = 0;
  try {
    process.stdout.write(`${JSON.stringify({ type: "error", code })}\n`);
  } catch {
    // The owning Main process observes the helper exit and closes the PTY tree.
  }
  try {
    pty?.kill();
  } catch {
    process.exitCode = 1;
  }
  if (pty === undefined) ptyExited = true;
  shutdownWhenDrained = true;
  maybeExit();
}

function maybeExit() {
  if (shutdownWhenDrained && ptyExited && !writing && pendingOutput.length === 0) {
    process.stdin.pause();
    setImmediate(() => process.exit(0));
  }
}

function splitUtf8(value, maxBytes) {
  const chunks = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes && chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += nextBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function isDimension(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}
