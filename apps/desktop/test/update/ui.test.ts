import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdatePanel } from "../../src/renderer/UpdatePanel.js";
import type { DesktopUpdateState } from "../../src/shared/update-contract.js";

const view = vi.hoisted(() => ({ state: null as DesktopUpdateState | null, hook: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: () => {},
  useState: (initial: unknown) => [view.hook++ === 0 ? view.state : initial, () => {}],
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
  message: "Check for a signed Desktop update.",
};
function render(state: Partial<DesktopUpdateState> = {}) {
  view.hook = 0;
  view.state = { ...base, ...state };
  vi.stubGlobal("window", { caelushDesktop: { update: {} } });
  return renderToStaticMarkup(createElement(UpdatePanel));
}
afterEach(() => vi.unstubAllGlobals());
describe("trusted update presentation", () => {
  it("shows the current version and accurate no-policy wording", () => {
    const html = render({
      status: "NO_POLICY",
      message: "There is currently no available update policy for this version and channel.",
    });
    expect(html).toContain("Caelush 0.1.0");
    expect(html).toContain("no available update policy");
    expect(html).toContain("Check for updates");
  });
  it("renders release notes as text, size and a cancellable download", () => {
    const html = render({
      status: "DOWNLOADING",
      latestVersion: "0.1.1",
      artifactSize: 1024 * 1024,
      downloadedBytes: 524288,
      releaseNotes: "<script>unsafe()</script>",
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("1.0");
    expect(html).toContain("50%");
    expect(html).toContain("Cancel download");
    expect(html).toContain('value="524288"');
  });
  it("presents confirmation, safe waiting, errors and the completed version", () => {
    expect(render({ status: "READY_TO_INSTALL" })).toContain("Install and restart");
    expect(render({ status: "WAITING_FOR_SAFE_SHUTDOWN" })).toContain("Retry safe installation");
    expect(render({ status: "WAITING_FOR_SAFE_SHUTDOWN" })).toContain("Later");
    expect(render({ status: "ERROR", message: "Integrity rejected" })).toContain('role="alert"');
    expect(render({ status: "COMPLETED", currentVersion: "0.1.1" })).toContain("Caelush 0.1.1");
  });
});
