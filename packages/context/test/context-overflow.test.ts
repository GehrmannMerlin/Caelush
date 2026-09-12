import { describe, expect, it } from "vitest";
import {
  ContextExhaustedError,
  ContextOverflowError,
  isContextOverflowError,
  recoverProviderContextOverflow,
} from "../src/context-overflow.js";

/**
 * Provider context overflow recovery.
 *
 * Since Phase 2C the agent model turn is executed by the AI core, so a real provider
 * overflow arrives as `AI_CONTEXT_OVERFLOW`. The legacy `CONTEXT_OVERFLOW` and
 * `LLM_CONTEXT_OVERFLOW` spellings stay recognised for the compatibility paths that
 * still exist. Recovery is exactly once: a second overflow is exhaustion, never another
 * compaction.
 */

function overflow(code: string): Error {
  const error = new Error("provider rejected the request") as Error & { code: string };
  error.name = "AIError";
  error.code = code;
  return error;
}

describe("isContextOverflowError", () => {
  it.each(["CONTEXT_OVERFLOW", "LLM_CONTEXT_OVERFLOW", "AI_CONTEXT_OVERFLOW"])(
    "recognises the %s spelling",
    (code) => {
      expect(isContextOverflowError(overflow(code))).toBe(true);
    },
  );

  it("recognises the typed Context error", () => {
    expect(isContextOverflowError(new ContextOverflowError())).toBe(true);
  });

  it("does not treat an unrelated failure as an overflow", () => {
    expect(isContextOverflowError(overflow("AI_NETWORK"))).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError("AI_CONTEXT_OVERFLOW")).toBe(false);
  });
});

describe("recoverProviderContextOverflow", () => {
  it("accepts the AI core's structured overflow classification", async () => {
    await expect(
      recoverProviderContextOverflow({
        execute: async () => {
          throw overflow("AI_CONTEXT_OVERFLOW");
        },
        forceCompact: async () => undefined,
        rehydrate: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ContextExhaustedError);
  });

  it("compacts and retries one logical request without rerunning tools", async () => {
    const order: string[] = [];
    let attempts = 0;

    const result = await recoverProviderContextOverflow({
      execute: async () => {
        attempts += 1;
        order.push(`execute:${attempts}`);
        if (attempts === 1) throw overflow("AI_CONTEXT_OVERFLOW");
        return "success";
      },
      forceCompact: async () => {
        order.push("compact");
      },
      rehydrate: async () => {
        order.push("rehydrate");
      },
    });

    expect(result).toEqual({ value: "success", recovered: true });
    // Exactly one compaction between exactly two transport attempts.
    expect(order).toEqual(["execute:1", "compact", "rehydrate", "execute:2"]);
    expect(attempts).toBe(2);
  });

  it("performs no recovery at all when the first attempt succeeds", async () => {
    let compactions = 0;
    const result = await recoverProviderContextOverflow({
      execute: async () => "answer",
      forceCompact: async () => {
        compactions += 1;
      },
      rehydrate: async () => undefined,
    });

    expect(result).toEqual({ value: "answer", recovered: false });
    expect(compactions).toBe(0);
  });

  it("fails explicitly after the one allowed overflow recovery", async () => {
    let attempts = 0;
    let compactions = 0;

    await expect(
      recoverProviderContextOverflow({
        execute: async () => {
          attempts += 1;
          throw overflow("AI_CONTEXT_OVERFLOW");
        },
        forceCompact: async () => {
          compactions += 1;
        },
        rehydrate: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ContextExhaustedError);

    // Two attempts and one compaction: never a third provider call.
    expect(compactions).toBe(1);
    expect(attempts).toBe(2);
  });

  it("propagates a non-overflow failure without compacting", async () => {
    let compactions = 0;
    const failure = overflow("AI_NETWORK");

    await expect(
      recoverProviderContextOverflow({
        execute: async () => {
          throw failure;
        },
        forceCompact: async () => {
          compactions += 1;
        },
        rehydrate: async () => undefined,
      }),
    ).rejects.toBe(failure);

    expect(compactions).toBe(0);
  });

  it("propagates a non-overflow failure from the recovered attempt", async () => {
    const failure = overflow("AI_NETWORK");
    let attempts = 0;

    await expect(
      recoverProviderContextOverflow({
        execute: async () => {
          attempts += 1;
          if (attempts === 1) throw overflow("AI_CONTEXT_OVERFLOW");
          throw failure;
        },
        forceCompact: async () => undefined,
        rehydrate: async () => undefined,
      }),
    ).rejects.toBe(failure);
  });
});
