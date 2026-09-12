import { describe, expect, it } from "vitest";
import { createCacheResolver } from "../src/cache/cache-resolver.js";
import { modelDescriptor } from "./support/fixtures.js";
import type { CacheRetention } from "../src/cache/cache-retention.js";
import type { CacheResolution } from "../src/cache/cache-resolution.js";
import type { ModelDescriptor } from "../src/models/model-descriptor.js";

function model(supportedRetentions: readonly CacheRetention[] | undefined): ModelDescriptor {
  if (supportedRetentions === undefined) return modelDescriptor();
  return modelDescriptor({ cache: { supportedRetentions } });
}

function resolve(
  supportedRetentions: readonly CacheRetention[] | undefined,
  request?: { retention: CacheRetention; key?: string },
): CacheResolution {
  return createCacheResolver().resolve({
    model: model(supportedRetentions),
    ...(request === undefined ? {} : { request }),
  });
}

describe("CacheResolver without a request", () => {
  it("resolves NONE / NONE / EXACT", () => {
    expect(resolve(["SHORT", "LONG"])).toEqual({
      requested: "NONE",
      effective: "NONE",
      mode: "EXACT",
    });
    expect(resolve(undefined)).toEqual({ requested: "NONE", effective: "NONE", mode: "EXACT" });
  });
});

describe("CacheResolver exact retention", () => {
  it("keeps NONE, SHORT and LONG when supported", () => {
    for (const retention of ["NONE", "SHORT", "LONG"] as CacheRetention[]) {
      expect(resolve(["NONE", "SHORT", "LONG"], { retention })).toEqual({
        requested: retention,
        effective: retention,
        mode: "EXACT",
      });
    }
  });

  it("treats a requested NONE as exact even without cache support", () => {
    expect(resolve([], { retention: "NONE" })).toEqual({
      requested: "NONE",
      effective: "NONE",
      mode: "EXACT",
    });
  });
});

describe("CacheResolver downgrade", () => {
  it("downgrades LONG to SHORT", () => {
    expect(resolve(["NONE", "SHORT"], { retention: "LONG" })).toEqual({
      requested: "LONG",
      effective: "SHORT",
      mode: "DOWNGRADED",
    });
  });

  it("downgrades LONG straight to NONE when only NONE is supported", () => {
    expect(resolve(["NONE"], { retention: "LONG" })).toEqual({
      requested: "LONG",
      effective: "NONE",
      mode: "DOWNGRADED",
    });
  });

  it("never upgrades a retention", () => {
    // SHORT must not become LONG, and NONE must not become SHORT.
    expect(resolve(["LONG"], { retention: "SHORT" })).toEqual({
      requested: "SHORT",
      effective: "NONE",
      mode: "DOWNGRADED",
    });
    expect(resolve(["SHORT", "LONG"], { retention: "NONE" })).toEqual({
      requested: "NONE",
      effective: "NONE",
      mode: "EXACT",
    });
  });

  it("downgrades to NONE rather than failing when caching is unsupported", () => {
    // An unsupported cache request is a downgrade, never a request failure: the
    // model call must still happen.
    expect(resolve([], { retention: "LONG" })).toEqual({
      requested: "LONG",
      effective: "NONE",
      mode: "DOWNGRADED",
    });
    expect(resolve(undefined, { retention: "LONG" })).toEqual({
      requested: "LONG",
      effective: "NONE",
      mode: "DOWNGRADED",
    });
  });
});

describe("CacheResolver key handling", () => {
  it("preserves the request cache key", () => {
    expect(resolve(["SHORT"], { retention: "SHORT", key: "conv-42" })).toEqual({
      requested: "SHORT",
      effective: "SHORT",
      mode: "EXACT",
      key: "conv-42",
    });
    expect(resolve(["NONE"], { retention: "LONG", key: "conv-42" })).toEqual({
      requested: "LONG",
      effective: "NONE",
      mode: "DOWNGRADED",
      key: "conv-42",
    });
  });

  it("omits the key when the request has none", () => {
    expect(resolve(["SHORT"], { retention: "SHORT" })).not.toHaveProperty("key");
    expect(resolve(["NONE", "SHORT"], { retention: "NONE" })).not.toHaveProperty("key");
  });

  it("keeps the key even when caching was downgraded away", () => {
    expect(resolve(["NONE"], { retention: "SHORT", key: "conv-42" })).toEqual({
      requested: "SHORT",
      effective: "NONE",
      mode: "DOWNGRADED",
      key: "conv-42",
    });
  });
});

describe("CacheResolver determinism", () => {
  it("resolves repeatedly to the same result", () => {
    const resolver = createCacheResolver();
    const input = { model: model(["SHORT"]), request: { retention: "LONG" as const } };

    expect(resolver.resolve(input)).toEqual(resolver.resolve(input));
  });
});
