import { describe, expect, it } from "vitest";
import { Utf8HeuristicTokenEstimator } from "../src/token-estimator.js";

describe("Utf8HeuristicTokenEstimator", () => {
  it("returns zero for empty text", () => {
    expect(new Utf8HeuristicTokenEstimator().estimateText("")).toBe(0);
  });

  it("estimates ASCII, CJK, and mixed text from UTF-8 bytes", () => {
    const estimator = new Utf8HeuristicTokenEstimator();
    expect(estimator.estimateText("abc")).toBe(1);
    expect(estimator.estimateText("你好")).toBe(2);
    expect(estimator.estimateText("const message = '你好';")).toBe(
      Math.ceil(Buffer.byteLength("const message = '你好';", "utf8") / 3),
    );
  });

  it("is deterministic for identical input", () => {
    const estimator = new Utf8HeuristicTokenEstimator();
    expect(estimator.estimateText("same input")).toBe(estimator.estimateText("same input"));
  });
});
