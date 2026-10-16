import { describe, expect, it, vi } from "vitest";
import { resolveClientHostIntegration } from "../src/host/desktop-integration.js";
import { detectDesktopPanelApi } from "../src/host/desktop-panel-api.js";

describe("client host integration", () => {
  it("keeps an ordinary browser free of Desktop integrations", () => {
    expect(resolveClientHostIntegration({})).toEqual({ kind: "WEB", loadingUi: false });
  });

  it("rejects an unsupported Desktop bridge protocol", () => {
    expect(
      resolveClientHostIntegration({
        caelushDesktop: { protocolVersion: 2, account: { logout: vi.fn() } },
      }),
    ).toEqual({ kind: "WEB", loadingUi: false });
  });

  it("projects only available version-one Desktop capabilities", async () => {
    const logout = vi.fn(async () => ({ serverRevoked: true }));
    const getSidebarProfile = vi.fn(async () => ({
      displayName: "霜华",
      avatarBytes: new Uint8Array([65]),
    }));
    const check = vi.fn(async () => ({ status: "IDLE" }));

    const integration = resolveClientHostIntegration({
      caelushDesktop: {
        protocolVersion: 1,
        account: { logout, getSidebarProfile },
        update: { check },
      },
    });

    expect(integration.kind).toBe("DESKTOP");
    if (integration.kind !== "DESKTOP") throw new Error("expected Desktop integration");
    expect(integration.loadingUi).toBe(true);
    expect(integration.account?.href).toBe("caelush-login://app/?view=account");
    await expect(integration.account?.logout()).resolves.toEqual({ serverRevoked: true });
    expect(integration.account?.getSidebarProfile).toBe(getSidebarProfile);
    await expect(integration.updates?.check()).resolves.toEqual({ status: "IDLE" });
    expect(logout).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    expect(integration.panelApi).toBeNull();
  });

  it("projects only a complete versioned Desktop appearance capability", () => {
    const appearance = {
      capabilityVersion: 1,
      initialSnapshot: { preference: "dark", resolvedTheme: "dark", revision: 3 },
      getSnapshot: vi.fn(async () => ({ preference: "dark", resolvedTheme: "dark", revision: 3 })),
      setPreference: vi.fn(async () => ({
        preference: "light",
        resolvedTheme: "light",
        revision: 4,
      })),
      subscribe: vi.fn(() => () => undefined),
    };
    const integration = resolveClientHostIntegration({
      caelushDesktop: { protocolVersion: 1, appearance },
    });

    if (integration.kind !== "DESKTOP") throw new Error("expected Desktop integration");
    expect(integration.appearance).toBe(appearance);
    const invalidSnapshot = resolveClientHostIntegration({
      caelushDesktop: {
        protocolVersion: 1,
        appearance: { ...appearance, initialSnapshot: { preference: "sepia" } },
      },
    });
    if (invalidSnapshot.kind !== "DESKTOP") throw new Error("expected Desktop integration");
    expect(invalidSnapshot.appearance).toBeUndefined();
    const unsupported = resolveClientHostIntegration({
      caelushDesktop: { protocolVersion: 1, appearance: { capabilityVersion: 2 } },
    });
    if (unsupported.kind !== "DESKTOP") throw new Error("expected Desktop integration");
    expect(unsupported.appearance).toBeUndefined();
  });

  it("disables an incomplete panel without disabling the other Desktop actions", () => {
    const integration = resolveClientHostIntegration({
      caelushDesktop: {
        protocolVersion: 1,
        workspace: { getAvailability: vi.fn(), subscribeAvailability: vi.fn() },
        browser: { createLease: vi.fn(), subscribeState: vi.fn() },
        account: { logout: async () => ({ serverRevoked: true }) },
      },
    });

    expect(integration.kind).toBe("DESKTOP");
    if (integration.kind !== "DESKTOP") throw new Error("expected Desktop integration");
    expect(integration.panelApi).toBeNull();
    expect(integration.account).toBeDefined();
  });

  it("does not expose the update settings surface for a check-only bridge", () => {
    const integration = resolveClientHostIntegration({
      caelushDesktop: { protocolVersion: 1, update: { check: async () => undefined } },
    });
    if (integration.kind !== "DESKTOP") throw new Error("expected Desktop integration");
    expect(integration.updates).toBeDefined();
    expect(integration.updateSettings).toBeUndefined();
  });

  it("exposes the update settings API only when its entire contract is available", () => {
    const update = {
      getState: vi.fn(),
      check: vi.fn(),
      download: vi.fn(),
      install: vi.fn(),
      cancelDownload: vi.fn(),
      deferInstall: vi.fn(),
      subscribeState: vi.fn(),
    };
    const integration = resolveClientHostIntegration({
      caelushDesktop: { protocolVersion: 1, update },
    });
    if (integration.kind !== "DESKTOP") throw new Error("expected Desktop integration");
    expect(integration.updateSettings).toBe(update);
  });

  it.each([true, false])(
    "preserves a complete native panel and honors availability=%s",
    async (available) => {
      const bridge = {
        protocolVersion: 1,
        workspace: {
          getAvailability: async () => ({ available }),
          subscribeAvailability: () => () => undefined,
          activate: () => undefined,
          listEntries: () => undefined,
          previewText: () => undefined,
          listEditors: () => undefined,
          openInEditor: () => undefined,
          terminal: {
            create: () => undefined,
            write: () => undefined,
            resize: () => undefined,
            close: () => undefined,
            subscribeOutput: () => undefined,
            acknowledgeOutput: () => undefined,
          },
        },
        browser: {
          createLease: () => undefined,
          navigate: () => undefined,
          goBack: () => undefined,
          goForward: () => undefined,
          reload: () => undefined,
          setBounds: () => undefined,
          closeLease: () => undefined,
          subscribeState: () => () => undefined,
        },
      };
      const integration = resolveClientHostIntegration({ caelushDesktop: bridge });
      if (integration.kind !== "DESKTOP") throw new Error("expected Desktop integration");
      expect(integration.panelApi).toBe(bridge);
      await expect(detectDesktopPanelApi(integration.panelApi)).resolves.toBe(
        available ? bridge : null,
      );
    },
  );
});
