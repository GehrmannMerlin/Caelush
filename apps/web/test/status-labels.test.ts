import { describe, expect, it } from "vitest";

import {
  approvalRiskLabel,
  presentationStatusLabel,
  toolStatusLabel,
  verificationStatusLabel,
} from "../src/presentation/status-labels.js";

describe("Web status labels", () => {
  it("translates every supported system status to Chinese", () => {
    expect(
      ["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((value) => approvalRiskLabel(value as never)),
    ).toEqual(["低风险", "中风险", "高风险", "严重风险"]);
    expect(
      ["STREAMING", "COMPLETED", "FAILED", "CANCELLED"].map((value) =>
        presentationStatusLabel(value as never),
      ),
    ).toEqual(["进行中", "已完成", "失败", "已取消"]);
    expect(toolStatusLabel("FUTURE_STATUS")).toBe("未知状态");
    expect(verificationStatusLabel("FUTURE_STATUS")).toBe("未知状态");
  });
});
