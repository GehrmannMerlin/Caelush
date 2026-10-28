import { describe, expect, it } from "vitest";
import {
  isCurrentAuthOperation,
  isCurrentAuthFeedback,
  resolveAuthMessage,
  type AuthFeedback,
} from "../../src/renderer/auth-feedback.js";

const currentFeedback: AuthFeedback = {
  screen: "login",
  generation: 4,
  tone: "info",
  message: "已退出登录，云端会话已撤销。",
};

describe("Desktop auth feedback scope", () => {
  it("accepts only the latest auth operation generation", () => {
    expect(isCurrentAuthOperation(4, 4)).toBe(true);
    expect(isCurrentAuthOperation(4, 5)).toBe(false);
  });

  it("shows feedback only for its current screen and generation", () => {
    expect(isCurrentAuthFeedback(currentFeedback, "login", 4)).toBe(true);
    expect(isCurrentAuthFeedback(currentFeedback, "register", 4)).toBe(false);
    expect(isCurrentAuthFeedback(currentFeedback, "login", 5)).toBe(false);
    expect(isCurrentAuthFeedback(null, "login", 4)).toBe(false);
  });

  it("does not revive a message after leaving and returning to the same screen", () => {
    expect(
      resolveAuthMessage(currentFeedback, "login", 6, {
        status: "LOGIN_REQUIRED",
        lastError: null,
        notice: null,
      }),
    ).toBeNull();
  });

  it("suppresses lastError while LOGIN_REQUIRED is the normal current state", () => {
    expect(
      resolveAuthMessage(null, "login", 4, {
        status: "LOGIN_REQUIRED",
        lastError: { code: "AUTH_INVALID_CREDENTIALS", message: "old failed login" },
        notice: null,
      }),
    ).toBeNull();
  });

  it.each([
    ["ERROR", "账户请求未能完成，请稍后重试。"],
    ["LOCKED", "无法访问 Windows 安全存储。请检查当前用户配置后重新启动 Caelush。"],
  ] as const)("shows %s account failures as errors", (status, message) => {
    expect(
      resolveAuthMessage(null, "login", 4, {
        status,
        lastError: {
          code: status === "LOCKED" ? "VAULT_UNAVAILABLE" : "REQUEST_FAILED",
          message: "private internal detail",
        },
        notice: null,
      }),
    ).toEqual({
      screen: "login",
      generation: 4,
      tone: "error",
      message,
    });
  });

  it("keeps current form success feedback informational", () => {
    expect(
      resolveAuthMessage(currentFeedback, "login", 4, {
        status: "LOGIN_REQUIRED",
        lastError: { code: "AUTH_INVALID_CREDENTIALS", message: "old failed login" },
        notice: null,
      }),
    ).toEqual(currentFeedback);
  });

  it("localizes account notices as informational messages", () => {
    expect(
      resolveAuthMessage(null, "login", 4, {
        status: "LOGIN_REQUIRED",
        lastError: null,
        notice: "Signed out. The Cloud session was revoked.",
      }),
    ).toEqual(currentFeedback);
  });

  it("does not carry a login notice onto another auth form", () => {
    expect(
      resolveAuthMessage(null, "register", 5, {
        status: "LOGIN_REQUIRED",
        lastError: null,
        notice: "Signed out. The Cloud session was revoked.",
      }),
    ).toBeNull();
  });
});
