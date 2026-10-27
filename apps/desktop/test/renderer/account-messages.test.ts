import { describe, expect, it } from "vitest";
import { errorMessage, localizeUiMessage } from "../../src/renderer/account-messages.js";

describe("Desktop account error messages", () => {
  it("explains an invalid account-state response by code without blaming credentials", () => {
    expect(
      errorMessage({
        code: "IPC_RESPONSE_INVALID",
        message: "The desktop request could not return a safe response.",
      }),
    ).toBe("账户状态读取异常，请重新打开账户页面后重试。");
  });

  it("explains a changed account state even when the server wording changes", () => {
    expect(errorMessage({ code: "ACCOUNT_STATE_INVALID", message: "Operation rejected." })).toBe(
      "账户状态已变化，请重新打开账户页面后重试。",
    );
  });

  it("preserves existing localization for errors outside the repaired codes", () => {
    expect(errorMessage({ code: "OTHER", message: "Network timeout" })).toBe(
      "网络连接暂不可用，请检查网络后重试。",
    );
    expect(errorMessage({ code: "OTHER", message: "已有明确的错误说明。" })).toBe(
      "已有明确的错误说明。",
    );
    expect(localizeUiMessage("The account request could not be completed.")).toBe(
      "账户请求未能完成，请检查信息或稍后重试。",
    );
    expect(errorMessage(null)).toBe("账户请求未能完成，请稍后重试。");
  });
});
