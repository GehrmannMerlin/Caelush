import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultDatabasePath } from "../src/main.js";
import {
  assertLoopbackDaemonHost,
  createDaemonConfig,
  DEFAULT_DAEMON_CONFIG,
  readProviderConfiguration,
  readProviderStreamPolicy,
} from "../src/config.js";
import { providerStreamPolicyDiagnostic } from "../src/diagnostics.js";

describe("daemon command startup", () => {
  it("derives the default database path cross-platform", () => {
    expect(getDefaultDatabasePath()).toBe(join(homedir(), ".caelush", "caelush.db"));
  });

  it("can be imported without opening a listener", async () => {
    const module = await import("../src/main.js");
    expect(module.main).toBeTypeOf("function");
  });

  it("translates provider environment values into runtime-only startup configuration", () => {
    expect(
      readProviderConfiguration({
        CAELUSH_PROVIDER_ID: "openai-compatible",
        CAELUSH_PROVIDER_BASE_URL: "https://provider.example/v1",
        CAELUSH_PROVIDER_API_KEY: "secret",
        CAELUSH_PROVIDER_ALLOWED_MODELS: "model-a, model-b",
        CAELUSH_DEFAULT_PROVIDER: "openai-compatible",
        CAELUSH_DEFAULT_MODEL: "model-a",
      }),
    ).toEqual({
      providers: [
        {
          provider: "openai-compatible",
          baseUrl: "https://provider.example/v1",
          apiKey: "secret",
          allowedModels: ["model-a", "model-b"],
        },
      ],
      defaultModel: { provider: "openai-compatible", model: "model-a" },
    });
  });

  it("rejects non-loopback production binding and partial provider configuration", () => {
    expect(() => assertLoopbackDaemonHost("0.0.0.0")).toThrow("loopback host");
    expect(() => assertLoopbackDaemonHost("[::1]")).not.toThrow();
    expect(() => readProviderConfiguration({ CAELUSH_PROVIDER_ID: "configured" })).toThrow(
      "required together",
    );
    expect(() => readProviderConfiguration({ CAELUSH_DEFAULT_PROVIDER: "configured" })).toThrow(
      "required together",
    );
  });

  it("validates the bounded RunEventHub policy at daemon configuration time", () => {
    expect(DEFAULT_DAEMON_CONFIG.runEventQueuePolicy).toMatchObject({
      maxPendingItems: 256,
      maxPendingBytes: 1_048_576,
    });
    expect(() =>
      createDaemonConfig({
        runEventQueuePolicy: {
          ...DEFAULT_DAEMON_CONFIG.runEventQueuePolicy,
          maxPendingItems: 0,
        },
      }),
    ).toThrow(/maxPendingItems/);
    expect(() =>
      createDaemonConfig({
        runEventQueuePolicy: {
          ...DEFAULT_DAEMON_CONFIG.runEventQueuePolicy,
          maxPendingBytes: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toThrow(/maxPendingBytes/);
  });

  it("uses finite, non-disableable Provider stream watchdog defaults", () => {
    expect(DEFAULT_DAEMON_CONFIG.providerStreamPolicy).toEqual({
      nudgeAfterMs: 30_000,
      idleTimeoutMs: 300_000,
      teardownGraceMs: 5_000,
    });
    for (const value of Object.values(DEFAULT_DAEMON_CONFIG.providerStreamPolicy)) {
      expect(Number.isSafeInteger(value) && value > 0).toBe(true);
    }
    expect(
      createDaemonConfig({ providerStreamPolicy: { idleTimeoutMs: 45_000 } }).providerStreamPolicy,
    ).toEqual({ nudgeAfterMs: 30_000, idleTimeoutMs: 45_000, teardownGraceMs: 5_000 });
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid idle watchdog timeout %s",
    (idleTimeoutMs) => {
      expect(() => createDaemonConfig({ providerStreamPolicy: { idleTimeoutMs } })).toThrow(
        /idleTimeoutMs/,
      );
    },
  );

  it("rejects a nudge deadline that is not earlier than the idle deadline", () => {
    expect(() =>
      createDaemonConfig({
        providerStreamPolicy: { nudgeAfterMs: 300_000, idleTimeoutMs: 300_000 },
      }),
    ).toThrow(/nudgeAfterMs must be less than idleTimeoutMs/);
  });

  it("reads bounded stream watchdog overrides from environment values", () => {
    expect(readProviderStreamPolicy({})).toEqual(DEFAULT_DAEMON_CONFIG.providerStreamPolicy);
    expect(
      readProviderStreamPolicy({
        CAELUSH_PROVIDER_NUDGE_AFTER_MS: "12000",
        CAELUSH_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "90000",
        CAELUSH_PROVIDER_TEARDOWN_GRACE_MS: "2500",
      }),
    ).toEqual({ nudgeAfterMs: 12_000, idleTimeoutMs: 90_000, teardownGraceMs: 2_500 });
    expect(() =>
      readProviderStreamPolicy({ CAELUSH_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "0" }),
    ).toThrow(/CAELUSH_PROVIDER_STREAM_IDLE_TIMEOUT_MS/);
    expect(() =>
      readProviderStreamPolicy({ CAELUSH_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "Infinity" }),
    ).toThrow(/CAELUSH_PROVIDER_STREAM_IDLE_TIMEOUT_MS/);
  });

  it("projects only safe watchdog durations into startup diagnostics", () => {
    expect(
      providerStreamPolicyDiagnostic({
        ...DEFAULT_DAEMON_CONFIG.providerStreamPolicy,
        endpoint: "https://private.example/v1?token=secret",
        apiKey: "secret",
      } as typeof DEFAULT_DAEMON_CONFIG.providerStreamPolicy),
    ).toEqual({ nudgeAfterMs: 30_000, idleTimeoutMs: 300_000, teardownGraceMs: 5_000 });
  });
});
