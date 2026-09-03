import { describe, expect, it } from "vitest";
import {
  ContextExhaustedError,
  ContextOverflowError,
  recoverProviderContextOverflow,
} from "../src/context-overflow.js";
import { LLMContextOverflowError } from "@caelush/llm/errors";

describe("provider context overflow recovery", () => {
  it("accepts the provider adapter's structured overflow classification", async () => {
    await expect(
      recoverProviderContextOverflow({
        execute: async () => {
          throw new LLMContextOverflowError();
        },
        forceCompact: async () => undefined,
        rehydrate: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ContextExhaustedError);
  });

  it("compacts and retries one logical request without rerunning tools", async () => {
    let attempts = 0;
    let compactions = 0;
    const result = await recoverProviderContextOverflow({
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new ContextOverflowError();
        return "success";
      },
      forceCompact: async () => {
        compactions += 1;
      },
      rehydrate: async () => undefined,
    });

    expect(result).toEqual({ value: "success", recovered: true });
    expect(attempts).toBe(2);
    expect(compactions).toBe(1);
  });

  it("fails explicitly after the one allowed overflow recovery", async () => {
    await expect(
      recoverProviderContextOverflow({
        execute: async () => {
          throw new ContextOverflowError();
        },
        forceCompact: async () => undefined,
        rehydrate: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ContextExhaustedError);
  });
});
