const authErrorMessages: Readonly<Record<string, string>> = {
  ACCOUNT_STATE_INVALID: "账户状态已变化，请重新打开账户页面后重试。",
  AUTH_INVALID_CREDENTIALS: "邮箱或密码不正确，或邮箱尚未完成验证，请检查后重试。",
  AUTH_RECOVERY_INVALID: "重置码无效、已过期或已使用，请重新申请密码重置邮件。",
  AUTH_REFRESH_REPLAYED: "云端会话已失效，请重新登录。",
  AUTH_SESSION_REVOKED: "云端会话已失效，请重新登录。",
  AUTH_TOKEN_EXPIRED: "云端会话已失效，请重新登录。",
  AUTH_TOKEN_INVALID: "云端会话已失效，请重新登录。",
  AUTH_VERIFICATION_INVALID: "验证码无效、已过期或已使用，请重新申请验证邮件。",
  CANCELLED: "操作已取消。",
  CLOUD_RESPONSE_INVALID: "服务返回的数据异常，请稍后重试。",
  DEVICE_LIMIT_REACHED: "已达到可授权设备数量上限，请先撤销不再使用的设备。",
  DEVICE_REVOKED: "此设备的访问权限已撤销，请重新登录。",
  INTERNAL_ERROR: "请求未能完成，请稍后重试。",
  IPC_CANCELLED: "操作已取消。",
  IPC_INPUT_INVALID: "提交的信息格式不正确，请检查后重试。",
  IPC_RESPONSE_INVALID: "账户状态读取异常，请重新打开账户页面后重试。",
  IPC_TIMEOUT: "请求超时，请稍后重试。",
  NETWORK_TIMEOUT: "网络连接暂不可用，请检查网络后重试。",
  NETWORK_UNAVAILABLE: "网络连接暂不可用，请检查网络后重试。",
  OFFLINE_GRANT_EXPIRED: "离线授权已过期，请连接云端并重新登录。",
  RATE_LIMITED: "操作过于频繁，请稍后重试。",
  REQUEST_FAILED: "账户请求未能完成，请稍后重试。",
  REQUEST_INVALID: "提交信息格式不正确，请检查后重试。",
  SERVICE_UNAVAILABLE: "服务暂不可用，请稍后重试。",
  SESSION_EXPIRED: "云端会话已失效，请重新登录。",
  VAULT_UNAVAILABLE: "无法访问 Windows 安全存储。请检查当前用户配置后重新启动 Caelush。",
};

const accountNotices: Readonly<Record<string, string>> = {
  "Connected online. The returned offline authorization could not be verified and was discarded.":
    "已连接云端，但返回的离线授权未能通过验证，已安全丢弃。",
  "Email verified. You can now sign in.": "邮箱已验证，现在可以登录。",
  "If the account exists, password recovery instructions have been sent.":
    "如果该邮箱已注册，我们已发送密码重置说明。",
  "If the account needs verification, a message has been sent.":
    "如果该账户需要验证，我们已重新发送验证邮件。",
  "If this email can be registered, a verification message has been sent.":
    "如果该邮箱可以注册，我们已发送验证邮件。",
  "Local credentials were cleared. Cloud session revocation could not be confirmed.":
    "已退出登录，但暂时无法确认云端会话是否撤销。",
  "No valid online session or offline authorization is available. Sign in when Cloud is reachable.":
    "当前没有可用的在线会话或离线授权，请在云端可连接时重新登录。",
  "Offline authorization could not be verified. Sign in when Cloud is reachable.":
    "无法验证离线授权，请在云端可连接时重新登录。",
  "Offline authorization has expired. Connect to Cloud and sign in again.":
    "离线授权已过期，请连接云端并重新登录。",
  "Offline authorization is active. It expires at the time shown above.":
    "离线授权已生效，可在上方查看有效期。",
  "Password changed. Sign in again.": "密码已更改，请重新登录。",
  "Password reset. Sign in with your new password.": "密码已重置，现在可以使用新密码登录。",
  "Signed out. The Cloud session was revoked.": "已退出登录，云端会话已撤销。",
  "The online session could not be restored. Sign in again to continue.":
    "无法恢复云端会话，请重新登录后继续。",
  "This device was revoked. Sign in on another device to continue.":
    "此设备的访问权限已撤销，请使用其他设备登录后继续。",
};

export function localizeUiMessage(message: string): string {
  if (/[\u3400-\u9fff]/u.test(message)) return message;
  const normalized = message.toLowerCase();
  if (normalized.includes("vault") || normalized.includes("credential storage")) {
    return "无法访问 Windows 安全存储。请检查当前用户配置后重新启动 Caelush。";
  }
  if (normalized.includes("expired") && normalized.includes("session")) {
    return "云端会话已过期，请重新连接账户后继续。";
  }
  if (normalized.includes("expired") && normalized.includes("offline")) {
    return "离线授权已过期，请连接云端后继续。";
  }
  if (
    normalized.includes("password") &&
    (normalized.includes("invalid") || normalized.includes("incorrect"))
  ) {
    return "密码不正确，请检查后重试。";
  }
  if (normalized.includes("verification") || normalized.includes("verify")) {
    return "邮箱验证未完成或验证码无效，请检查邮件后重试。";
  }
  if (normalized.includes("email")) return "邮箱地址无效或账户请求未能完成，请检查后重试。";
  if (
    normalized.includes("network") ||
    normalized.includes("fetch") ||
    normalized.includes("timeout")
  ) {
    return "网络连接暂不可用，请检查网络后重试。";
  }
  if (normalized.includes("device")) return "设备授权请求未能完成，请重新连接账户后重试。";
  if (normalized.includes("request") || normalized.includes("account")) {
    return "账户请求未能完成，请检查信息或稍后重试。";
  }
  return "请求未能完成，请检查信息或网络连接后重试。";
}

export function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    if (error.code === "IPC_RESPONSE_INVALID")
      return "账户状态读取异常，请重新打开账户页面后重试。";
    if (error.code === "ACCOUNT_STATE_INVALID") return "账户状态已变化，请重新打开账户页面后重试。";
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return localizeUiMessage(error.message.slice(0, 512));
  }
  return "账户请求未能完成，请稍后重试。";
}

export function authErrorMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    Object.hasOwn(error, "code") &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const code = error.code.slice(0, 64);
    const message = authErrorMessages[code];
    if (Object.hasOwn(authErrorMessages, code) && message !== undefined) return message;
  }
  return "请求未能完成，请检查信息或网络连接后重试。";
}

export function accountNoticeMessage(notice: string): string {
  if (/[㐀-鿿]/u.test(notice)) return notice.slice(0, 512);
  const boundedNotice = notice.slice(0, 512);
  const message = accountNotices[boundedNotice];
  return Object.hasOwn(accountNotices, boundedNotice) && message !== undefined
    ? message
    : "账户状态已更新。";
}
