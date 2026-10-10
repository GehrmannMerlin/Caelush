import { describe, expect, it } from "vitest";
import { BrowserGuestError, validateBrowserUrl } from "../../src/main/browser/url-policy.js";

describe("Browser Guest URL policy", () => {
  it.each([
    "file:///C:/Users/test/secret.txt",
    "javascript:alert(1)",
    "data:text/html,hello",
    "chrome://settings",
    "devtools://devtools/bundled/",
    "caelush-app://app/api/v1/health",
    "https://user:pass@example.com/",
    "http://example.com/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[fe80::1]/",
    "https://localhost/",
    "https://printer.local/",
  ])("rejects unsafe or private navigation target %s", async (url) => {
    await expect(
      validateBrowserUrl(url, { lookup: async () => [{ address: "93.184.216.34", family: 4 }] }),
    ).rejects.toBeInstanceOf(BrowserGuestError);
  });

  it("allows a public HTTPS hostname only when all DNS answers are public", async () => {
    const lookup = async (hostname: string) => {
      expect(hostname).toBe("example.com");
      return [{ address: "93.184.216.34", family: 4 }];
    };

    await expect(
      validateBrowserUrl("https://example.com/docs?q=desktop", { lookup }),
    ).resolves.toBe("https://example.com/docs?q=desktop");
    await expect(
      validateBrowserUrl("https://mixed.example.org", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "192.168.1.10", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: "BROWSER_PRIVATE_ADDRESS" });

    await expect(
      validateBrowserUrl("https://mixed-v6.example.org", {
        lookup: async () => [
          { address: "2606:4700:4700::1111", family: 6 },
          { address: "fd00::10", family: 6 },
        ],
      }),
    ).rejects.toMatchObject({ code: "BROWSER_PRIVATE_ADDRESS" });
  });
});
