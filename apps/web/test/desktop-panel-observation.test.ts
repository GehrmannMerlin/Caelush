import { describe, expect, it } from "vitest";
import { observeDesktopPanelApi, type DesktopPanelApi } from "../src/host/desktop-panel-api.js";

function fixture() {
  const listeners = new Set<(available: boolean) => void>();
  let resolve!: (value: { available: boolean }) => void;
  const initial = new Promise<{ available: boolean }>((done) => {
    resolve = done;
  });
  const api = {
    workspace: {
      getAvailability: () => initial,
      subscribeAvailability: (listener: (available: boolean) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as DesktopPanelApi;
  return { api, listeners, resolve };
}

describe("native panel availability observation", () => {
  it("publishes the initial availability and subsequent changes, then unsubscribes", async () => {
    const { api, listeners, resolve } = fixture();
    const values: (DesktopPanelApi | null)[] = [];
    const stop = observeDesktopPanelApi(api, (value) => values.push(value));
    resolve({ available: true });
    await new Promise((done) => setImmediate(done));
    expect(values).toEqual([api]);
    for (const listener of listeners) listener(false);
    for (const listener of listeners) listener(true);
    expect(values).toEqual([api, null, api]);
    stop();
    expect(listeners.size).toBe(0);
  });

  it("does not overwrite a newer availability event with an older pending read", async () => {
    const { api, listeners, resolve } = fixture();
    const values: (DesktopPanelApi | null)[] = [];
    const stop = observeDesktopPanelApi(api, (value) => values.push(value));
    for (const listener of listeners) listener(false);
    resolve({ available: true });
    await new Promise((done) => setImmediate(done));
    expect(values).toEqual([null]);
    stop();
  });

  it("ignores an initial read that finishes after disposal", async () => {
    const { api, resolve } = fixture();
    const values: (DesktopPanelApi | null)[] = [];
    const stop = observeDesktopPanelApi(api, (value) => values.push(value));
    stop();
    resolve({ available: true });
    await new Promise((done) => setImmediate(done));
    expect(values).toEqual([]);
  });
});
