import { afterEach, describe, expect, it, vi } from "vitest";
import { createAbortScope } from "../src/stream/abort-scope.js";

afterEach(() => vi.useRealTimers());

describe("AI invocation abort scope", () => {
  it("aborts the stable adapter signal with an idle-timeout cause", async () => {
    const scope = createAbortScope(undefined, undefined);

    scope.abortIdle();

    expect(scope.signal.aborted).toBe(true);
    expect(scope.kind()).toBe("idle_timeout");
    await expect(scope.aborted).resolves.toBe("idle_timeout");
    scope.cleanup();
  });

  it("keeps the first abort cause when idle timeout races with user cancellation", async () => {
    const userSignal = new AbortController();
    const scope = createAbortScope(userSignal.signal, undefined);

    userSignal.abort();
    scope.abortIdle();

    expect(scope.kind()).toBe("external");
    await expect(scope.aborted).resolves.toBe("external");
    scope.cleanup();
  });

  it("keeps idle timeout as the cause when a later consumer cancellation arrives", async () => {
    const scope = createAbortScope(undefined, undefined);

    scope.abortIdle();
    scope.abortConsumer();

    expect(scope.kind()).toBe("idle_timeout");
    await expect(scope.aborted).resolves.toBe("idle_timeout");
    scope.cleanup();
  });

  it("detaches external cancellation listeners during cleanup", () => {
    const userSignal = new AbortController();
    const scope = createAbortScope(userSignal.signal, undefined);

    scope.cleanup();
    userSignal.abort();

    expect(scope.signal.aborted).toBe(false);
    expect(scope.kind()).toBeUndefined();
  });

  it("does not replace idle timeout when the total invocation timer fires later", async () => {
    vi.useFakeTimers();
    const scope = createAbortScope(undefined, 50);

    scope.abortIdle();
    await vi.advanceTimersByTimeAsync(50);

    expect(scope.kind()).toBe("idle_timeout");
    await expect(scope.aborted).resolves.toBe("idle_timeout");
    scope.cleanup();
  });
});
