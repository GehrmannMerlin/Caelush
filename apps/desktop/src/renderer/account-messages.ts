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
