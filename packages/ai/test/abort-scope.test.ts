import { describe, expect, it } from "vitest";
import { createAbortScope } from "../src/stream/abort-scope.js";

/** Wait for the scope to report an abort, or fail loudly after a bounded wait. */
async function kindOf(scope: ReturnType<typeof createAbortScope>): Promise<string> {
  return Promise.race([
    scope.aborted,
    new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve("TIMED_OUT_WAITING");
      }, 1_000);
    }),
  ]);
}

describe("AbortScope", () => {
  it("is not aborted while nothing has fired", () => {
    const scope = createAbortScope(undefined, 5_000);

    expect(scope.signal.aborted).toBe(false);
    expect(scope.kind()).toBeUndefined();
    scope.cleanup();
  });

  it("reports an external abort", async () => {
    const controller = new AbortController();
    const scope = createAbortScope(controller.signal, 5_000);

    controller.abort();

    expect(await kindOf(scope)).toBe("external");
    expect(scope.kind()).toBe("external");
    expect(scope.signal.aborted).toBe(true);
    scope.cleanup();
  });

  it("reports an abort that already happened before the scope existed", () => {
    const controller = new AbortController();
    controller.abort();

    const scope = createAbortScope(controller.signal, 5_000);

    expect(scope.kind()).toBe("external");
    expect(scope.signal.aborted).toBe(true);
    scope.cleanup();
  });

  it("reports a timeout", async () => {
    const scope = createAbortScope(undefined, 10);

    expect(await kindOf(scope)).toBe("timeout");
    expect(scope.kind()).toBe("timeout");
    scope.cleanup();
  });

  it("reports a consumer cancellation", async () => {
    const scope = createAbortScope(undefined, 5_000);

    scope.abortConsumer();

    expect(await kindOf(scope)).toBe("consumer");
    expect(scope.kind()).toBe("consumer");
    scope.cleanup();
  });

  it("keeps the first cause when several fire", async () => {
    const controller = new AbortController();
    const scope = createAbortScope(controller.signal, 5_000);

    scope.abortConsumer();
    controller.abort();
    scope.abortConsumer();

    expect(await kindOf(scope)).toBe("consumer");
    expect(scope.kind()).toBe("consumer");
    scope.cleanup();
  });

  it("lets an external abort win over a later timeout", async () => {
    const controller = new AbortController();
    const scope = createAbortScope(controller.signal, 5);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(scope.kind()).toBe("external");
    scope.cleanup();
  });

  it("stops the timeout after cleanup", async () => {
    const scope = createAbortScope(undefined, 10);

    scope.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(scope.kind()).toBeUndefined();
    expect(scope.signal.aborted).toBe(false);
  });

  it("detaches from the external signal after cleanup", async () => {
    const controller = new AbortController();
    const scope = createAbortScope(controller.signal, 5_000);

    scope.cleanup();
    controller.abort();

    expect(scope.kind()).toBeUndefined();
    expect(scope.signal.aborted).toBe(false);
  });

  it("uses its own signal, never the external one", () => {
    const controller = new AbortController();
    const scope = createAbortScope(controller.signal, 5_000);

    expect(scope.signal).not.toBe(controller.signal);
    scope.cleanup();
  });
});
