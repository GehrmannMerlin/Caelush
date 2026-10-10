const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { sendIpcAndWaitForMessage } = require("./poc-ipc.cjs");

function makeChild(send) {
  const child = new EventEmitter();
  child.connected = true;
  child.exitCode = null;
  child.signalCode = null;
  child.send = send;
  return child;
}

function assertNoWaitListeners(child) {
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
}

test("waits for an IPC response even when it arrives before the send callback", async () => {
  const child = makeChild((message, callback) => {
    assert.equal(child.listenerCount("message"), 1);
    child.emit("message", { type: "READY", generation: message.generation });
    callback(null);
  });

  const response = await sendIpcAndWaitForMessage(
    child,
    { type: "START", generation: "generation-1" },
    100,
    "CHILD_EXIT_BEFORE_READY",
    "STARTUP_TIMEOUT",
    (message) => message?.type === "READY",
  );

  assert.deepEqual(response, { type: "READY", generation: "generation-1" });
  assertNoWaitListeners(child);
});

test("cleans response listeners when the IPC send fails", async () => {
  const child = makeChild((_message, callback) => callback(new Error("send failed")));

  await assert.rejects(
    sendIpcAndWaitForMessage(child, { type: "PING" }, 100, "CHILD_EXIT", "PING_TIMEOUT"),
    { code: "PRIVATE_IPC_SEND_FAILED" },
  );
  assertNoWaitListeners(child);
});

test("cleans response listeners when an IPC response times out", async () => {
  const child = makeChild((_message, callback) => callback(null));

  await assert.rejects(
    sendIpcAndWaitForMessage(child, { type: "PING" }, 10, "CHILD_EXIT", "PING_TIMEOUT"),
    { code: "PING_TIMEOUT" },
  );
  assertNoWaitListeners(child);
});

test("cleans response listeners when the child exits before its IPC response", async () => {
  const child = makeChild((_message, callback) => {
    child.emit("exit", 17);
    callback(null);
  });

  await assert.rejects(
    sendIpcAndWaitForMessage(child, { type: "PING" }, 100, "CHILD_EXIT", "PING_TIMEOUT"),
    { code: "CHILD_EXIT" },
  );
  assertNoWaitListeners(child);
});
