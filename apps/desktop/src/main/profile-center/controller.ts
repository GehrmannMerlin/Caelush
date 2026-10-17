import { CaelushClient, CaelushClientHttpError, CaelushClientProtocolError } from "@caelush/client";
import { UsageSummaryQuerySchema, type UsageSummaryQuery } from "@caelush/protocol";
import type { DesktopDaemonSupervisor } from "../daemon/supervisor.js";
import type { DesktopDaemonProxyLease } from "../protocol/local-proxy.js";
import { ownedDaemonHeaders } from "../protocol/daemon-authorization.js";
import { AccountCenterSnapshotSchema, type AccountCenterSnapshot } from "./contract.js";

export class DesktopProfileCenterError extends Error {
  constructor(
    readonly code:
      | "PROFILE_CENTER_SCOPE_CHANGED"
      | "PROFILE_CENTER_UNAVAILABLE"
      | "PROFILE_CENTER_UNSUPPORTED"
      | "DESKTOP_ACCOUNT_UNAUTHORIZED"
      | "PROFILE_CENTER_RESPONSE_INVALID",
  ) {
    const messages = {
      PROFILE_CENTER_SCOPE_CHANGED: "账户或本地服务已切换，请重新打开个人信息页。",
      PROFILE_CENTER_UNAVAILABLE: "最近工作与用量暂时无法读取，请重试。",
      PROFILE_CENTER_UNSUPPORTED: "本地 Agent 版本过旧，请更新后查看最近工作与用量。",
      DESKTOP_ACCOUNT_UNAUTHORIZED: "请先登录并授权当前账号。",
      PROFILE_CENTER_RESPONSE_INVALID: "本地 Agent 返回了无法识别的个人中心数据。",
    };
    super(messages[code]);
    this.name = "DesktopProfileCenterError";
  }
}

export interface DesktopProfileCenterControllerOptions {
  readonly supervisor: Pick<
    DesktopDaemonSupervisor,
    "acquireProxyLease" | "getActiveProfileIdentity"
  >;
  readonly getAuthorizedUserId: () => string | null;
  readonly fetcher?: typeof fetch;
}

export class DesktopProfileCenterController {
  constructor(private readonly options: DesktopProfileCenterControllerOptions) {}

  getSnapshot(input: UsageSummaryQuery, signal: AbortSignal): Promise<AccountCenterSnapshot> {
    const query = UsageSummaryQuerySchema.parse(input);
    return this.withClient(signal, async (client, signal) => {
      const [sessions, usage] = await Promise.all([
        client.listSessions({ limit: 20 }, { signal }),
        client.getUsageSummary(query, { signal }),
      ]);
      const recentSessions = sessions.items.slice(0, 3).map((session) => ({
        id: session.id,
        title: safeSessionTitle(session.title),
        updatedAt: session.updatedAt,
      }));
      return AccountCenterSnapshotSchema.parse({ recentSessions, usage });
    });
  }

  private assertCurrent(
    lease: Pick<DesktopDaemonProxyLease, "userId" | "profileId" | "generationId">,
  ): void {
    if (this.options.getAuthorizedUserId() !== lease.userId)
      throw new DesktopProfileCenterError("PROFILE_CENTER_SCOPE_CHANGED");
    const current = this.options.supervisor.getActiveProfileIdentity();
    if (
      current === null ||
      current.userId !== lease.userId ||
      current.profileId !== lease.profileId ||
      current.generationId !== lease.generationId
    )
      throw new DesktopProfileCenterError("PROFILE_CENTER_SCOPE_CHANGED");
  }

  private async withClient<T>(
    signal: AbortSignal,
    action: (client: CaelushClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.options.getAuthorizedUserId() === null)
      throw new DesktopProfileCenterError("DESKTOP_ACCOUNT_UNAUTHORIZED");
    const identity = this.options.supervisor.getActiveProfileIdentity();
    if (identity === null) throw new DesktopProfileCenterError("PROFILE_CENTER_UNAVAILABLE");
    this.assertCurrent(identity);
    const lease = this.options.supervisor.acquireProxyLease(signal);
    if (lease === null) throw new DesktopProfileCenterError("PROFILE_CENTER_UNAVAILABLE");
    try {
      this.assertCurrent(lease);
      const headers = ownedDaemonHeaders(lease);
      if (headers === null) throw new DesktopProfileCenterError("PROFILE_CENTER_UNAVAILABLE");
      const fetcher = this.options.fetcher ?? globalThis.fetch.bind(globalThis);
      const client = new CaelushClient({
        baseUrl: lease.baseUrl,
        headers,
        fetch: (input, init) => fetcher(input, { ...init, redirect: "error" }),
      });
      lease.signal.throwIfAborted();
      const result = await action(client, lease.signal);
      this.assertCurrent(lease);
      lease.signal.throwIfAborted();
      return result;
    } catch (error) {
      this.assertCurrent(lease);
      if (error instanceof DesktopProfileCenterError) throw error;
      if (error instanceof CaelushClientHttpError && error.status === 404)
        throw new DesktopProfileCenterError("PROFILE_CENTER_UNSUPPORTED");
      if (error instanceof CaelushClientProtocolError)
        throw new DesktopProfileCenterError("PROFILE_CENTER_RESPONSE_INVALID");
      throw new DesktopProfileCenterError("PROFILE_CENTER_UNAVAILABLE");
    } finally {
      lease.release();
    }
  }
}

function safeSessionTitle(value: string | undefined): string {
  const normalized = (value ?? "新对话")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cs}\u2028\u2029]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized || "新对话")
    .slice(0, 96)
    .join("");
}
