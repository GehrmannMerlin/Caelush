/** Opaque handle owned by a FrameScheduler implementation. */
export type FrameHandle = object;

/** Host scheduling used only for visual publication and reconciliation. */
export interface FrameScheduler {
  /** Enqueues the callback for a future frame or task; implementations never call it synchronously. */
  schedule(callback: () => void): FrameHandle;
  cancel(handle: FrameHandle): void;
}

const cancellationByHandle = new WeakMap<FrameHandle, () => void>();

/** Browser frame scheduling with a task fallback for environments without requestAnimationFrame. */
export const browserFrameScheduler: FrameScheduler = Object.freeze({
  schedule(callback: () => void): FrameHandle {
    const handle = {};
    if (typeof globalThis.requestAnimationFrame === "function") {
      const frameId = globalThis.requestAnimationFrame(() => callback());
      cancellationByHandle.set(handle, () => globalThis.cancelAnimationFrame(frameId));
    } else {
      const timeoutId = globalThis.setTimeout(callback, 0);
      cancellationByHandle.set(handle, () => globalThis.clearTimeout(timeoutId));
    }
    return handle;
  },
  cancel(handle: FrameHandle): void {
    cancellationByHandle.get(handle)?.();
    cancellationByHandle.delete(handle);
  },
});
