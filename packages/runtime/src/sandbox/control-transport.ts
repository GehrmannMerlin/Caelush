import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { terminateProcessTree } from "../exec/process-tree.js";
import { RuntimeSandboxError, RuntimeSandboxProtocolError } from "../runtime-errors.js";
import {
  acceptSandboxWorkspacePrepared,
  acceptSandboxWorkspaceStatus,
  acceptSandboxReady,
  decodeSandboxControlMessage,
  encodeSandboxControlMessage,
  MAX_SANDBOX_CONTROL_MESSAGE_BYTES,
  type SandboxHelloMessage,
  type SandboxReadyMessage,
  type SandboxWorkspacePreparedMessage,
  type SandboxWorkspaceStatusMessage,
} from "./control-protocol.js";

export const DEFAULT_SANDBOX_READY_TIMEOUT_MS = 5_000;

export interface SandboxControlTransport {
  readonly runnerArgs: readonly string[];
  waitForReady(child: ChildProcess, hello: SandboxHelloMessage): Promise<SandboxReadyMessage>;
  waitForWorkspaceStatus(
    child: ChildProcess,
    hello: SandboxHelloMessage,
  ): Promise<SandboxWorkspaceStatusMessage>;
  waitForWorkspacePrepared(
    child: ChildProcess,
    hello: SandboxHelloMessage,
  ): Promise<SandboxWorkspacePreparedMessage>;
  close(): Promise<void>;
}

export async function createSandboxControlTransport(input: {
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly hello: SandboxHelloMessage;
}): Promise<SandboxControlTransport> {
  encodeSandboxControlMessage(input.hello);
  const timeoutMs = input.timeoutMs ?? DEFAULT_SANDBOX_READY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RuntimeSandboxProtocolError("Sandbox control timeout is invalid.");
  }
  if ((input.platform ?? process.platform) === "win32") {
    return createWindowsControlTransport(timeoutMs);
  }
  return createUnixControlTransport(timeoutMs);
}

function createUnixControlTransport(timeoutMs: number): SandboxControlTransport {
  let control: Readable | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    control?.destroy();
  };
  return {
    runnerArgs: Object.freeze([]),
    waitForReady: async (child, hello) => {
      const candidate = child.stdio[3];
      if (!(candidate instanceof Readable)) {
        await failClosed(child, close);
        throw new RuntimeSandboxError(
          "The native sandbox runner did not provide a control channel.",
        );
      }
      control = candidate;
      return waitForReadyMessage(child, Promise.resolve(candidate), hello, timeoutMs, close);
    },
    waitForWorkspaceStatus: async (child, hello) => {
      const candidate = child.stdio[3];
      if (!(candidate instanceof Readable)) {
        await failClosed(child, close);
        throw new RuntimeSandboxError(
          "The native sandbox runner did not provide a control channel.",
        );
      }
      control = candidate;
      return waitForWorkspaceStatusMessage(
        child,
        Promise.resolve(candidate),
        hello,
        timeoutMs,
        close,
      );
    },
    waitForWorkspacePrepared: async (child, hello) => {
      const candidate = child.stdio[3];
      if (!(candidate instanceof Readable)) {
        await failClosed(child, close);
        throw new RuntimeSandboxError(
          "The native sandbox runner did not provide a control channel.",
        );
      }
      control = candidate;
      return waitForWorkspacePreparedMessage(
        child,
        Promise.resolve(candidate),
        hello,
        timeoutMs,
        close,
      );
    },
    close,
  };
}

async function createWindowsControlTransport(timeoutMs: number): Promise<SandboxControlTransport> {
  const pipeName = `\\\\.\\pipe\\caelush-sandbox-${randomUUID()}`;
  let socket: Socket | undefined;
  let closed = false;
  let resolveConnection: ((value: Readable) => void) | undefined;
  const connection = new Promise<Readable>((resolve) => {
    resolveConnection = resolve;
  });
  const server = createServer((candidate) => {
    if (socket !== undefined || closed) {
      candidate.destroy();
      return;
    }
    socket = candidate;
    resolveConnection?.(candidate);
  });
  await listen(server, pipeName);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    socket?.destroy();
    await closeServer(server);
  };
  return {
    runnerArgs: Object.freeze(["--control-pipe", pipeName]),
    waitForReady: (child, hello) => waitForReadyMessage(child, connection, hello, timeoutMs, close),
    waitForWorkspaceStatus: (child, hello) =>
      waitForWorkspaceStatusMessage(child, connection, hello, timeoutMs, close),
    waitForWorkspacePrepared: (child, hello) =>
      waitForWorkspacePreparedMessage(child, connection, hello, timeoutMs, close),
    close,
  };
}

function listen(server: Server, pipeName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (): void => {
      server.removeListener("listening", onListening);
      reject(new RuntimeSandboxError("The Windows sandbox control pipe could not be created."));
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(pipeName);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function waitForReadyMessage(
  child: ChildProcess,
  controlPromise: Promise<Readable>,
  hello: SandboxHelloMessage,
  timeoutMs: number,
  closeTransport: () => Promise<void>,
): Promise<SandboxReadyMessage> {
  return waitForExpectedMessage(
    child,
    controlPromise,
    hello,
    timeoutMs,
    closeTransport,
    (message) => acceptSandboxReady(message, hello),
  );
}

function waitForWorkspaceStatusMessage(
  child: ChildProcess,
  controlPromise: Promise<Readable>,
  hello: SandboxHelloMessage,
  timeoutMs: number,
  closeTransport: () => Promise<void>,
): Promise<SandboxWorkspaceStatusMessage> {
  return waitForExpectedMessage(
    child,
    controlPromise,
    hello,
    timeoutMs,
    closeTransport,
    (message) => acceptSandboxWorkspaceStatus(message, hello),
  );
}

function waitForWorkspacePreparedMessage(
  child: ChildProcess,
  controlPromise: Promise<Readable>,
  hello: SandboxHelloMessage,
  timeoutMs: number,
  closeTransport: () => Promise<void>,
): Promise<SandboxWorkspacePreparedMessage> {
  return waitForExpectedMessage(
    child,
    controlPromise,
    hello,
    timeoutMs,
    closeTransport,
    (message) => acceptSandboxWorkspacePrepared(message, hello),
  );
}

function waitForExpectedMessage<TMessage>(
  child: ChildProcess,
  controlPromise: Promise<Readable>,
  hello: SandboxHelloMessage,
  timeoutMs: number,
  closeTransport: () => Promise<void>,
  accept: (message: import("./control-protocol.js").SandboxControlMessage) => TMessage,
): Promise<TMessage> {
  return new Promise<TMessage>((resolve, reject) => {
    let settled = false;
    let control: Readable | undefined;
    let buffer = Buffer.alloc(0);

    const removeListeners = (): void => {
      clearTimeout(timer);
      child.removeListener("error", onChildError);
      child.removeListener("close", onChildClose);
      control?.removeListener("data", onData);
      control?.removeListener("error", onControlError);
      control?.removeListener("end", onControlEnd);
      control?.removeListener("close", onControlEnd);
    };
    const succeed = (message: TMessage): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      void closeTransport().then(() => resolve(message), reject);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      void failClosed(child, closeTransport).then(() => {
        if (error instanceof RuntimeSandboxProtocolError || error instanceof RuntimeSandboxError) {
          reject(error);
          return;
        }
        reject(new RuntimeSandboxError("The native sandbox runner did not prove its boundary."));
      }, reject);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.byteLength > MAX_SANDBOX_CONTROL_MESSAGE_BYTES) {
        fail(new RuntimeSandboxProtocolError("Sandbox control channel exceeded its size limit."));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString("utf8").trim();
      if (line.length === 0) {
        buffer = buffer.subarray(newline + 1);
        return;
      }
      try {
        succeed(accept(decodeSandboxControlMessage(line)));
      } catch (error) {
        fail(error);
      }
    };
    const onChildError = (): void =>
      fail(new RuntimeSandboxError("The native sandbox runner failed before READY."));
    const onChildClose = (): void =>
      fail(new RuntimeSandboxError("The native sandbox runner exited before READY."));
    const onControlError = (): void =>
      fail(new RuntimeSandboxError("The native sandbox control channel failed before READY."));
    const onControlEnd = (): void =>
      fail(new RuntimeSandboxError("The native sandbox control channel closed before READY."));
    const timer = setTimeout(
      () =>
        fail(
          new RuntimeSandboxError(
            `The native sandbox runner did not send READY within ${timeoutMs.toLocaleString("en-US")} ms.`,
          ),
        ),
      timeoutMs,
    );

    child.once("error", onChildError);
    child.once("close", onChildClose);
    if (child.exitCode !== null) {
      onChildClose();
      return;
    }
    void controlPromise.then((value) => {
      if (settled) {
        value.destroy();
        return;
      }
      control = value;
      value.on("data", onData);
      value.once("error", onControlError);
      value.once("end", onControlEnd);
      value.once("close", onControlEnd);
    }, onControlError);
  });
}

async function failClosed(child: ChildProcess, closeTransport: () => Promise<void>): Promise<void> {
  await closeTransport();
  await terminateProcessTree({
    pid: child.pid,
    kill: (signal) => child.kill(signal),
  });
}
