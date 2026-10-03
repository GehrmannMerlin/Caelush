import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SANDBOX_CONTROL_MESSAGE_BYTES,
  SANDBOX_CONTROL_PROTOCOL_VERSION,
  createSandboxControlTransport,
  createSandboxHello,
  encodeSandboxControlMessage,
} from "../src/index.js";

const hello = () =>
  createSandboxHello({
    nonce: "transport-nonce-1",
    providerId: "windows-acl-restricted-token",
    boundaryFingerprint: "transport-boundary-1",
  });

const readyLine = (expected: ReturnType<typeof hello>) =>
  `${encodeSandboxControlMessage({
    type: "READY",
    protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    nonce: expected.nonce,
    providerId: expected.providerId,
    boundaryFingerprint: expected.boundaryFingerprint,
    enforcement: "NONE",
  })}\n`;

const workspaceStatusLine = (expected: ReturnType<typeof hello>) =>
  `${encodeSandboxControlMessage({
    type: "WORKSPACE_STATUS",
    protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    nonce: expected.nonce,
    providerId: expected.providerId,
    boundaryFingerprint: expected.boundaryFingerprint,
    status: "MISSING",
  })}\n`;

const workspacePreparedLine = (expected: ReturnType<typeof hello>) =>
  `${encodeSandboxControlMessage({
    type: "WORKSPACE_PREPARED",
    protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    nonce: expected.nonce,
    providerId: expected.providerId,
    boundaryFingerprint: expected.boundaryFingerprint,
    change: "UNCHANGED",
  })}\n`;

const errorLine = (expected: ReturnType<typeof hello>, code: string) =>
  `${encodeSandboxControlMessage({
    type: "ERROR",
    protocolVersion: SANDBOX_CONTROL_PROTOCOL_VERSION,
    nonce: expected.nonce,
    code,
  })}\n`;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly control = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr, this.control];
  readonly pid = undefined;
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sandbox control transport", () => {
  it("accepts a nonce-bound READY only from the Unix fd 3 control stream", async () => {
    const expected = hello();
    const child = new FakeChild();
    const transport = await createSandboxControlTransport({
      platform: "linux",
      hello: expected,
    });

    expect(transport.runnerArgs).toEqual([]);
    const waiting = transport.waitForReady(child.asChildProcess(), expected);
    child.control.end(readyLine(expected));

    await expect(waiting).resolves.toMatchObject({ type: "READY", enforcement: "NONE" });
    expect(child.killed).toBe(false);
    await transport.close();
  });

  it("accepts workspace status and preparation messages only from the Unix control stream", async () => {
    const expected = hello();
    const statusChild = new FakeChild();
    const statusTransport = await createSandboxControlTransport({
      platform: "linux",
      hello: expected,
    });
    const statusWaiting = statusTransport.waitForWorkspaceStatus(
      statusChild.asChildProcess(),
      expected,
    );
    statusChild.control.end(workspaceStatusLine(expected));
    await expect(statusWaiting).resolves.toMatchObject({
      type: "WORKSPACE_STATUS",
      status: "MISSING",
    });
    await statusTransport.close();

    const preparedChild = new FakeChild();
    const preparedTransport = await createSandboxControlTransport({
      platform: "linux",
      hello: expected,
    });
    const preparedWaiting = preparedTransport.waitForWorkspacePrepared(
      preparedChild.asChildProcess(),
      expected,
    );
    preparedChild.control.end(workspacePreparedLine(expected));
    await expect(preparedWaiting).resolves.toMatchObject({
      type: "WORKSPACE_PREPARED",
      change: "UNCHANGED",
    });
    await preparedTransport.close();
  });

  it("preserves a bounded workspace preparation error and terminates the Runner", async () => {
    const expected = hello();
    const child = new FakeChild();
    const transport = await createSandboxControlTransport({
      platform: "linux",
      hello: expected,
    });
    const waiting = transport.waitForWorkspacePrepared(child.asChildProcess(), expected);
    child.control.end(errorLine(expected, "WINDOWS_WORKSPACE_WRITE_OWNER_REQUIRED"));

    await expect(waiting).rejects.toMatchObject({
      reasonCode: "WINDOWS_WORKSPACE_WRITE_OWNER_REQUIRED",
    });
    expect(child.killed).toBe(true);
    await transport.close();
  });

  it("times out at the 5,000 ms default and terminates the Runner", async () => {
    vi.useFakeTimers();
    const expected = hello();
    const child = new FakeChild();
    const transport = await createSandboxControlTransport({
      platform: "linux",
      hello: expected,
    });
    const waiting = transport.waitForReady(child.asChildProcess(), expected);
    const rejection = expect(waiting).rejects.toThrow(/5,000 ms/i);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(child.killed).toBe(true);
    await transport.close();
  });

  it.each([
    ["malformed JSON", Buffer.from("not-json\n")],
    ["an oversized message", Buffer.alloc(MAX_SANDBOX_CONTROL_MESSAGE_BYTES + 1, 0x78)],
  ])("rejects %s and terminates the Runner", async (_label, payload) => {
    const expected = hello();
    const child = new FakeChild();
    const transport = await createSandboxControlTransport({
      platform: "linux",
      hello: expected,
    });
    const waiting = transport.waitForReady(child.asChildProcess(), expected);
    child.control.write(payload);

    await expect(waiting).rejects.toThrow(/control|protocol|size/i);
    expect(child.killed).toBe(true);
    await transport.close();
  });

  it("rejects a Runner that exits before READY", async () => {
    const expected = hello();
    const child = new FakeChild();
    const transport = await createSandboxControlTransport({
      platform: "linux",
      hello: expected,
    });
    const waiting = transport.waitForReady(child.asChildProcess(), expected);
    child.exitCode = 1;
    child.emit("close", 1, null);

    await expect(waiting).rejects.toThrow(/exited before READY/i);
    expect(child.killed).toBe(true);
    await transport.close();
  });

  it("ignores a valid-looking READY written by the payload to stdout", async () => {
    const expected = hello();
    const child = new FakeChild();
    const transport = await createSandboxControlTransport({
      platform: "linux",
      hello: expected,
    });
    let settled = false;
    const waiting = transport.waitForReady(child.asChildProcess(), expected).finally(() => {
      settled = true;
    });

    child.stdout.write(readyLine(expected));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.control.end(readyLine(expected));
    await expect(waiting).resolves.toMatchObject({ type: "READY" });
    await transport.close();
  });

  it("creates an unpredictable Windows pipe passed only as a private Runner argument", async () => {
    const first = await createSandboxControlTransport({ platform: "win32", hello: hello() });
    const second = await createSandboxControlTransport({ platform: "win32", hello: hello() });
    try {
      expect(first.runnerArgs).toHaveLength(2);
      expect(first.runnerArgs[0]).toBe("--control-pipe");
      expect(first.runnerArgs[1]).toMatch(/^\\\\\.\\pipe\\caelush-sandbox-[0-9a-f-]+$/i);
      expect(second.runnerArgs[1]).not.toBe(first.runnerArgs[1]);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
