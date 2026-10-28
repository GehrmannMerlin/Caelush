import { describe, expect, it } from "vitest";
import {
  accountNoticeMessage,
  authErrorMessage,
  errorMessage,
  localizeUiMessage,
} from "../../src/renderer/account-messages.js";

describe("Desktop auth error messages", () => {
  it("explains an invalid account-state response by code without blaming credentials", () => {
    expect(
      authErrorMessage({
        code: "IPC_RESPONSE_INVALID",
        message: "The desktop request could not return a safe response.",
      }),
    ).toBe("账户状态读取异常，请重新打开账户页面后重试。");
  });

  it("explains a changed account state even when the server wording changes", () => {
    expect(
      authErrorMessage({ code: "ACCOUNT_STATE_INVALID", message: "Operation rejected." }),
    ).toBe("账户状态已变化，请重新打开账户页面后重试。");
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

  it.each([
    ["AUTH_INVALID_CREDENTIALS", "邮箱或密码不正确，或邮箱尚未完成验证，请检查后重试。"],
    ["AUTH_VERIFICATION_INVALID", "验证码无效、已过期或已使用，请重新申请验证邮件。"],
    ["AUTH_RECOVERY_INVALID", "重置码无效、已过期或已使用，请重新申请密码重置邮件。"],
    ["REQUEST_INVALID", "提交信息格式不正确，请检查后重试。"],
    ["DEVICE_LIMIT_REACHED", "已达到可授权设备数量上限，请先撤销不再使用的设备。"],
    ["RATE_LIMITED", "操作过于频繁，请稍后重试。"],
    ["SERVICE_UNAVAILABLE", "服务暂不可用，请稍后重试。"],
    ["NETWORK_UNAVAILABLE", "网络连接暂不可用，请检查网络后重试。"],
    ["NETWORK_TIMEOUT", "网络连接暂不可用，请检查网络后重试。"],
  ])("maps %s by code rather than relying on the server wording", (code, expected) => {
    expect(authErrorMessage({ code, message: "Upstream wording changed." })).toBe(expected);
  });

  it.each(["private backend diagnostic", "服务器内部诊断信息，不应展示给用户。"])(
    "does not echo arbitrary text from an unknown error code: %s",
    (message) => {
      expect(authErrorMessage({ code: "UNKNOWN_CLOUD_ERROR", message })).toBe(
        "请求未能完成，请检查信息或网络连接后重试。",
      );
    },
  );

  it("uses the safe fallback for malformed and prototype-property codes", () => {
    expect(authErrorMessage({ message: "private diagnostic" })).toBe(
      "请求未能完成，请检查信息或网络连接后重试。",
    );
    expect(authErrorMessage({ code: "toString", message: "private diagnostic" })).toBe(
      "请求未能完成，请检查信息或网络连接后重试。",
    );
  });

  it("keeps code-first auth wording scoped away from account-page errors", () => {
    expect(
      errorMessage({ code: "AUTH_INVALID_CREDENTIALS", message: "Invalid email or password." }),
    ).toBe("密码不正确，请检查后重试。");
    expect(errorMessage({ code: "RATE_LIMITED", message: "Too many requests." })).toBe(
      "账户请求未能完成，请检查信息或稍后重试。",
    );
  });

  it.each([
    ["Signed out. The Cloud session was revoked.", "已退出登录，云端会话已撤销。"],
    [
      "Local credentials were cleared. Cloud session revocation could not be confirmed.",
      "已退出登录，但暂时无法确认云端会话是否撤销。",
    ],
  ])("localizes the account notice %s", (notice, expected) => {
    expect(accountNoticeMessage(notice)).toBe(expected);
  });

  it("does not resolve prototype properties as account notices", () => {
    expect(accountNoticeMessage("constructor")).toBe("账户状态已更新。");
  });
});
