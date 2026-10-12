import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdatePage } from "../../src/renderer/UpdatePage.js";
import type {
  DesktopReleaseHistoryItem,
  DesktopUpdateState,
} from "../../src/shared/update-contract.js";

const view = vi.hoisted(() => ({
  state: null as DesktopUpdateState | null,
  releases: [] as DesktopReleaseHistoryItem[],
  open: false,
  hook: 0,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const slot = view.hook++;
    if (slot === 0) return [view.state, () => {}];
    if (slot === 2) return [view.releases, () => {}];
    if (slot === 4) return [view.open, () => {}];
    return [initial, () => {}];
  },
}));
const base: DesktopUpdateState = {
  status: "IDLE",
  currentVersion: "0.1.0",
  latestVersion: null,
  releaseNotes: "",
  artifactSize: 0,
  downloadedBytes: 0,
  mandatory: false,
  graceDeadline: null,
  errorCode: null,
  message: "可检查已签名的桌面端更新。",
};
const releases: DesktopReleaseHistoryItem[] = [
  {
    version: "0.1.1",
    channel: "dev",
    publishedAt: "2026-10-12T00:00:00.000Z",
    releaseNotes: "新增版本记录内容",
  },
  {
    version: "0.1.0",
    channel: "dev",
    publishedAt: "2026-10-11T00:00:00.000Z",
    releaseNotes: "首个公开版本",
  },
];
function render(state: Partial<DesktopUpdateState> = {}, history = releases) {
  view.hook = 0;
  view.state = { ...base, ...state };
  view.releases = history;
  view.open = true;
  vi.stubGlobal("window", { caelushDesktop: { update: {} } });
  return renderToStaticMarkup(createElement(UpdatePage));
}
afterEach(() => vi.unstubAllGlobals());
describe("update page presentation", () => {
  it("shows a page with update-introduction versions and selected release notes", () => {
    const html = render();
    expect(html).toContain("检查更新");
    expect(html).toContain("更新介绍");
    expect(html).toContain("0.1.1");
    expect(html).toContain("0.1.0");
    expect(html).toContain("新增版本记录内容");
    expect(html).not.toContain("desktop-update-panel");
  });
  it("renders release notes as text rather than markup", () => {
    const html = render({}, [
      {
        ...releases[0]!,
        releaseNotes: "<script>unsafe()</script>",
      },
    ]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("does not describe a missing policy as proof that the current version is latest", () => {
    const html = render({
      status: "NO_POLICY",
      message: "There is currently no available update policy for this version and channel.",
    });
    expect(html).toContain("Caelush 0.1.0");
    expect(html).toContain("无法确认是否有新版本");
    expect(html).toContain("检查更新");
    expect(html).not.toContain("There is currently no available update policy");
  });
  it("renders download progress, safe installation actions and the completed version", () => {
    const html = render({
      status: "DOWNLOADING",
      latestVersion: "0.1.1",
      artifactSize: 1024 * 1024,
      downloadedBytes: 524288,
      releaseNotes: "版本更新：新增功能 <script>不安全()</script>",
    });
    expect(html).toContain("1.0");
    expect(html).toContain("50%");
    expect(html).toContain("取消下载");
    expect(html).toContain('value="524288"');
    expect(render({ status: "READY_TO_INSTALL" })).toContain("安装并重启");
    expect(render({ status: "WAITING_FOR_SAFE_SHUTDOWN" })).toContain("重试安全安装");
    expect(render({ status: "WAITING_FOR_SAFE_SHUTDOWN" })).toContain("稍后");
    expect(render({ status: "ERROR", message: "Integrity rejected" })).toContain('role="alert"');
    expect(render({ status: "COMPLETED", currentVersion: "0.1.1" })).toContain("Caelush 0.1.1");
  });
});
