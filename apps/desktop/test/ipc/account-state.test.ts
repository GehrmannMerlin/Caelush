import { describe, expect, it, vi } from "vitest";
import { createInitialAccountState } from "../../src/main/account/state.js";
import { IPC_CHANNELS, publishAccountState } from "../../src/main/ipc/handlers.js";

describe("account state publication", () => {
  it("publishes a validated snapshot on the existing account channel", () => {
    const target = { send: vi.fn() };
    const state = createInitialAccountState("AUTHENTICATED_ONLINE");
    publishAccountState(target, state);
    expect(target.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.account.state, state);
    expect(target.send.mock.calls[0]?.[1]).not.toBe(state);
  });

  it("rejects out-of-contract state instead of bypassing the IPC schema", () => {
    const target = { send: vi.fn() };
    publishAccountState(target, {
      ...createInitialAccountState("AUTHENTICATED_ONLINE"),
      offlineGrant: {
        issuedAt: "2026-10-27T08:00:00.000Z",
        expiresAt: "2026-11-11T08:00:00.000Z",
        entitlements: ["CAELUSH_DESKTOP_BASIC"],
        remainingHours: 361,
      },
    });
    publishAccountState(target, {
      ...createInitialAccountState(),
      accessToken: "must-not-reach-the-renderer",
    } as ReturnType<typeof createInitialAccountState>);
    expect(target.send).not.toHaveBeenCalled();
  });
});
