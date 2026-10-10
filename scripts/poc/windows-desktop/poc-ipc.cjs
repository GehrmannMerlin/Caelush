class PocError extends Error {
  constructor(code) {
    super(code);
    this.name = "PocError";
    this.code = code;
  }
}

function sendIpcAndWaitForMessage(
  child,
  message,
  timeoutMs,
  exitCode,
  timeoutCode = exitCode,
  acceptMessage = () => true,
  onSent,
) {
  const waiter = createMessageWaiter(child, timeoutMs, exitCode, timeoutCode, acceptMessage);
  const response = waiter.promise.then(
    (messageValue) => ({ type: "RESPONSE", message: messageValue }),
    (error) => ({ type: "WAIT_ERROR", error }),
  );
  const sent = sendIpc(child, message).then(
    () => {
      try {
        onSent?.();
      } catch {
        // An observation callback cannot change IPC delivery.
      }
      return { type: "SENT" };
    },
    (error) => ({ type: "SEND_ERROR", error }),
  );

  return Promise.race([response, sent]).then((first) => {
    if (first.type === "RESPONSE") return first.message;
    if (first.type === "WAIT_ERROR") throw first.error;
    if (first.type === "SEND_ERROR") {
      waiter.cancel(first.error);
      throw first.error;
    }
    return waiter.promise;
  });
}

function createMessageWaiter(child, timeoutMs, exitCode, timeoutCode, acceptMessage) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return rejectedWaiter(new PocError(exitCode));
  }

  let settled = false;
  let rejectPromise;
  let resolvePromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const cleanup = () => {
    clearTimeout(timer);
    child.removeListener("message", onMessage);
    child.removeListener("exit", onExit);
    child.removeListener("error", onError);
  };
  const settleResolve = (message) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(message);
  };
  const settleReject = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(error);
  };
  const onMessage = (message) => {
    let accepted;
    try {
      accepted = acceptMessage(message);
    } catch (error) {
      settleReject(error);
      return;
    }
    if (accepted) settleResolve(message);
  };
  const onExit = () => settleReject(new PocError(exitCode));
  const onError = () => settleReject(new PocError("CHILD_PROCESS_ERROR"));
  const timer = setTimeout(() => settleReject(new PocError(timeoutCode)), timeoutMs);
  child.on("message", onMessage);
  child.once("exit", onExit);
  child.once("error", onError);

  return { promise, cancel: settleReject };
}

function rejectedWaiter(error) {
  return { promise: Promise.reject(error), cancel: () => undefined };
}

function sendIpc(child, message) {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
      reject(new PocError("CHILD_CHANNEL_CLOSED"));
      return;
    }
    try {
      child.send(message, (error) => {
        if (error) reject(new PocError("PRIVATE_IPC_SEND_FAILED"));
        else resolve();
      });
    } catch {
      reject(new PocError("PRIVATE_IPC_SEND_FAILED"));
    }
  });
}

module.exports = { sendIpcAndWaitForMessage };
