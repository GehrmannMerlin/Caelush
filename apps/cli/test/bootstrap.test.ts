import { CaelushClientProtocolError, CaelushProtocolCompatibilityError } from "@caelush/client";
import { describe, expect, it } from "vitest";
import { resolveDaemonUrl } from "../src/bootstrap/daemon-client.js";
import { toSafeCliError } from "../src/bootstrap/safe-errors.js";

describe("CLI bootstrap helpers", () => {
  it("uses the configured daemon URL or the loopback default", () => {
    expect(resolveDaemonUrl({ CAELUSH_DAEMON_URL: "http://daemon.test:43120" })).toBe(
      "http://daemon.test:43120",
    );
    expect(resolveDaemonUrl({ CAELUSH_DAEMON_URL: "  " })).toBe("http://127.0.0.1:43120");
    expect(resolveDaemonUrl({})).toBe("http://127.0.0.1:43120");
  });

  it("maps transport and protocol failures to safe public messages", () => {
    expect(
      toSafeCliError(new CaelushClientProtocolError("Daemon request failed: ECONNREFUSED")),
    ).toBe("Caelush Local Agent Service is not reachable.");
    expect(toSafeCliError(new CaelushProtocolCompatibilityError())).toBe(
      "Daemon protocol compatibility check failed.",
    );
  });
});
