/* global URL, fetch, process, document, window, HTMLElement, getComputedStyle */

import { chromium } from "@playwright/test";

const [url, artifactDirectory, workspaceJson] = process.argv.slice(2);
if (url === undefined || artifactDirectory === undefined || workspaceJson === undefined) {
  throw new Error("Browser smoke requires URL, artifact directory, and workspace JSON.");
}
const workspace = JSON.parse(workspaceJson);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const promptCacheOnly = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "PROMPT_CACHE";
const multiTurnOnly = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "MULTI_TURN";
const s0Only = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "S0";
const s1Only = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "S1";
const s2Only = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "S2";
const s3Only = process.env.CAELUSH_BROWSER_SMOKE_SCOPE === "S3";
const S2_COMPLETE_TEXT = `S2_COMPLETE ${"word ".repeat(1_800).trim()}`;
const waitVisible = (locator, timeout = 15_000) => locator.waitFor({ state: "visible", timeout });
const waitUntil = async (predicate, description, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description);
    await page.waitForTimeout(100);
  }
};
const exactText = (value) => page.getByText(value, { exact: true });
const startNewSession = async () => {
  const newSessionButton = page.locator("button.workspace-new-session-button").first();
  if ((await newSessionButton.count()) === 0) {
    const selectedWorkspace = page
      .locator('button.workspace-list-button[aria-current="page"]')
      .first();
    if (
      (await selectedWorkspace.count()) !== 0 &&
      (await selectedWorkspace.getAttribute("aria-expanded")) !== "true"
    ) {
      await selectedWorkspace.click();
    }
  }
  await waitVisible(newSessionButton);
  await newSessionButton.click();
};
const selectSession = async (title) => {
  await page.locator("button.workspace-session-item").filter({ hasText: title }).click();
};
/**
 * Expand the execution-process disclosure and keep it open.
 *
 * ```text
 * details.timeline                     legacy <Timeline>; NOT rendered once a turn presentation exists
 * details.turn-presentation-process    the disclosure a user actually sees
 * ```
 *
 * `session-workspace.ts` renders exactly one of the two and prefers `TurnPresentationFeed`, so a
 * selector aimed at `details.timeline` matched nothing and this step silently did *nothing* — the
 * failure only appeared 15 s later as a missing entry. The presentation disclosure also
 * auto-collapses on the active→settled transition (`expanded` tracks `isActive`), so an expansion
 * issued while the Run is still settling is undone a moment later. Retrying until the body stays
 * visible absorbs both: a disclosure that is genuinely broken still throws here.
 */
const openProcessDisclosure = async () => {
  const disclosure = page.locator("details.turn-presentation-process").first();
  await waitVisible(disclosure);
  const body = disclosure.locator(".turn-presentation-body");
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await body.isVisible()) return;
    if (Date.now() > deadline)
      throw new Error("the execution-process disclosure never stayed open");
    await disclosure.locator("summary").first().click();
    await page.waitForTimeout(150);
  }
};
/**
 * The split layout, in the state it is actually in.
 *
 * ```text
 * empty landing (no session content)   workspace-column--static  overflow-y hidden, no rail
 * a session with turns or a live Run   workspace-column         overflow-y auto,   stable rail
 * ```
 *
 * `f13566a` introduced the two-state column and did not update this check, so it kept demanding
 * `overflow-y: auto` from a landing page that is deliberately fixed. Asserting whichever state the
 * page is in would be circular, so the caller states which one it expects and both halves are
 * checked: the modifier and the computed style must agree with it.
 */
const assertViewportSplitLayout = async (options = {}) => {
  const scrollable = options.scrollable ?? false;
  const layout = await page.evaluate(() => {
    const sidebar = document.querySelector(".workspace-sidebar");
    const sessionScroll = document.querySelector(".session-scroll");
    const workspaceColumn = document.querySelector(".workspace-column");
    const addWorkspaceButton = document.querySelector(".workspace-add-button");
    const workspaceCard = document.querySelector(".workspace-card");
    if (!(sidebar instanceof HTMLElement)) throw new Error("workspace sidebar missing");
    if (!(sessionScroll instanceof HTMLElement)) throw new Error("session scroll region missing");
    if (!(workspaceColumn instanceof HTMLElement)) throw new Error("workspace column missing");
    if (!(addWorkspaceButton instanceof HTMLElement))
      throw new Error("add workspace button missing");
    if (!(workspaceCard instanceof HTMLElement)) throw new Error("workspace card missing");
    const sidebarStyle = getComputedStyle(sidebar);
    const sessionScrollStyle = getComputedStyle(sessionScroll);
    const columnStyle = getComputedStyle(workspaceColumn);
    const addWorkspaceButtonStyle = getComputedStyle(addWorkspaceButton);
    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      documentFitsViewport: document.documentElement.scrollHeight <= window.innerHeight + 1,
      bodyFitsViewport: document.body.scrollHeight <= window.innerHeight + 1,
      topbarCount: document.querySelectorAll(".web-topbar").length,
      brandInSidebar: sidebar.querySelector(".workspace-sidebar-brand") !== null,
      sidebarPosition: sidebarStyle.position,
      sidebarOverflowY: sidebarStyle.overflowY,
      sidebarBackgroundImage: sidebarStyle.backgroundImage,
      sessionOverflowY: sessionScrollStyle.overflowY,
      columnClass: workspaceColumn.className,
      columnOverflowY: columnStyle.overflowY,
      columnScrollbarGutter: columnStyle.scrollbarGutter,
      addWorkspaceButtonWidth: addWorkspaceButton.getBoundingClientRect().width,
      workspaceCardWidth: workspaceCard.getBoundingClientRect().width,
      addWorkspaceButtonTextAlign: addWorkspaceButtonStyle.textAlign,
      addWorkspaceButtonColor: addWorkspaceButtonStyle.color,
    };
  });
  if (layout.topbarCount !== 0) throw new Error("desktop top navigation still exists");
  if (!layout.brandInSidebar) throw new Error("Agent brand is not inside the sidebar");
  if (layout.bodyOverflow !== "hidden")
    throw new Error("body scroll is not locked, observed " + layout.bodyOverflow);
  if (!layout.documentFitsViewport || !layout.bodyFitsViewport)
    throw new Error("page-level vertical scroll leaked outside the panels");
  if (layout.sidebarPosition !== "fixed")
    throw new Error("sidebar is not fixed, observed " + layout.sidebarPosition);
  if (layout.sidebarOverflowY !== "auto")
    throw new Error("sidebar does not own vertical scroll, observed " + layout.sidebarOverflowY);
  if (layout.sessionOverflowY !== "visible")
    throw new Error(
      "session scroll region should defer vertical scroll to the workspace rail, observed " +
        layout.sessionOverflowY,
    );
  if (layout.sidebarBackgroundImage !== "none") throw new Error("sidebar uses a gradient");
  if (Math.abs(layout.addWorkspaceButtonWidth - layout.workspaceCardWidth) > 1)
    throw new Error(
      `add workspace button is ${layout.addWorkspaceButtonWidth}px wide, card is ${layout.workspaceCardWidth}px`,
    );
  if (layout.addWorkspaceButtonTextAlign !== "center")
    throw new Error("add workspace button text is not centered");
  if (layout.addWorkspaceButtonColor !== "rgb(17, 24, 39)")
    throw new Error("sidebar action text is not high contrast");

  const observed = `${layout.columnClass} overflow-y=${layout.columnOverflowY} gutter=${layout.columnScrollbarGutter}`;
  if (scrollable) {
    if (layout.columnClass.includes("workspace-column--static"))
      throw new Error("a session with content kept the static column modifier: " + observed);
    if (layout.columnOverflowY !== "auto")
      throw new Error("workspace column does not own the primary vertical scroll: " + observed);
    if (layout.columnScrollbarGutter !== "stable")
      throw new Error("workspace column does not reserve the right-edge rail: " + observed);
  } else {
    if (!layout.columnClass.includes("workspace-column--static"))
      throw new Error("the empty landing state dropped the static column modifier: " + observed);
    if (layout.columnOverflowY !== "hidden")
      throw new Error("the empty landing state still scrolls its column: " + observed);
    if (layout.columnScrollbarGutter !== "auto")
      throw new Error("the empty landing state still reserves a rail: " + observed);
  }
};
const postJson = async (path, payload) => {
  const response = await fetch(new URL(path, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok)
    throw new Error("HTTP " + response.status + " from " + path + ": " + (await response.text()));
  return response.json();
};
const getJson = async (path) => {
  const response = await fetch(new URL(path, url));
  if (!response.ok)
    throw new Error("HTTP " + response.status + " from " + path + ": " + (await response.text()));
  return response.json();
};

/**
 * The three permission choices, asserted as the browser actually renders them.
 *
 * ```text
 * unprepared workspace   VIEW_ONLY selected      WORKSPACE_WRITE offers 准备工作区内修改
 * after preparation      WORKSPACE_WRITE selected, the affordance is gone
 * FULL_ACCESS            never applied until 确认使用完全权限 is pressed
 * ```
 *
 * The labels are asserted in Chinese because that is what a user reads, and the values because the
 * value is what reaches the Daemon: a label that matches while the value does not would still submit
 * the wrong preset. The preparation step is asserted through its affordance rather than a status
 * caption — the caption helpers exist in the application layer but no component renders one, so a
 * caption assertion would pass against a UI that never shows it.
 */
const assertPermissionSelector = async () => {
  await waitVisible(page.locator(".permission-selector"));
  const select = page.locator("select.permission-selector-select");
  await waitVisible(select);
  // The selector renders before the capability read settles, and an empty preset list would fail the
  // three-choices assertion below for a reason that has nothing to do with the choices.
  await waitUntil(
    async () => (await select.locator("option").count()) === 3,
    "the three permission choices to load",
  );
  if ((await select.getAttribute("aria-label")) !== "选择权限")
    throw new Error("the permission selector is not labelled 选择权限");

  const options = await select
    .locator("option")
    .evaluateAll((elements) =>
      elements.map((element) => ({ value: element.value, label: element.textContent ?? "" })),
    );
  const expectedOptions = [
    { value: "VIEW_ONLY", label: "仅可查看" },
    { value: "WORKSPACE_WRITE", label: "工作区内修改" },
    { value: "FULL_ACCESS", label: "完全权限" },
  ];
  if (JSON.stringify(options) !== JSON.stringify(expectedOptions))
    throw new Error("the permission choices changed: " + JSON.stringify(options));

  const selected = await select.inputValue();
  if (selected !== "VIEW_ONLY")
    throw new Error("an unprepared workspace selected " + selected + " instead of 仅可查看");

  // Switching between the first two choices exercises both direct selection and the existing
  // workspace-preparation path; PREPARATION_REQUIRED is selectable and prepares on selection.
  await select.selectOption("WORKSPACE_WRITE");
  await waitUntil(
    async () => (await select.inputValue()) === "WORKSPACE_WRITE",
    "workspace write permission to prepare",
  );
  await select.selectOption("VIEW_ONLY");
  if ((await select.inputValue()) !== "VIEW_ONLY")
    throw new Error("could not switch from 工作区内修改 back to 仅可查看");
  await select.selectOption("WORKSPACE_WRITE");
  if ((await select.inputValue()) !== "WORKSPACE_WRITE")
    throw new Error("could not switch from 仅可查看 to 工作区内修改");

  // Full Access is the only preset gated behind an explicit confirmation, so the gate itself is the
  // assertion: the value must not move until the confirming button is pressed.
  await select.selectOption("FULL_ACCESS");
  const dialog = page.locator(".permission-selector-confirmation");
  await waitVisible(dialog);
  const heading = (await dialog.locator("h2").innerText()).trim();
  if (heading !== "确认完全权限")
    throw new Error("the Full Access confirmation heading changed: " + heading);
  const copy = (await dialog.locator("p").allInnerTexts()).map((line) => line.trim());
  const expectedCopy = [
    "完全权限会让 Agent 使用主机用户范围执行文件、进程和网络操作。",
    "硬安全规则仍然有效；权限不足的动作会被拒绝，不会自动批准。",
    "不透明的第三方二进制仍可能隐藏文件读取或网络外传。",
  ];
  if (JSON.stringify(copy) !== JSON.stringify(expectedCopy))
    throw new Error("the Full Access confirmation copy changed: " + JSON.stringify(copy));
  const unconfirmed = await select.inputValue();
  if (unconfirmed !== "WORKSPACE_WRITE")
    throw new Error("选择完全权限 was applied as " + unconfirmed + " before it was confirmed");
  await dialog.locator("button", { hasText: "确认使用完全权限" }).click();
  await page
    .locator(".permission-selector-confirmation")
    .waitFor({ state: "detached", timeout: 15_000 });
  const confirmed = await select.inputValue();
  if (confirmed !== "FULL_ACCESS")
    throw new Error("confirming 完全权限 selected " + confirmed + " instead of it");

  // Leave the composer on 工作区内修改 so every scenario below runs against the workspace boundary.
  await select.selectOption("WORKSPACE_WRITE");
  const restored = await select.inputValue();
  if (restored !== "WORKSPACE_WRITE")
    throw new Error("could not restore 工作区内修改 after the Full Access check: " + restored);
};

/**
 * Type a prompt and submit it, waiting for the composer to accept one.
 *
 * The submit button stays disabled until the model directory has resolved to a selection the Daemon
 * advertises, so clicking straight after a reload is a race. When it never settles, the diagnostic
 * names what the composer was actually waiting on rather than leaving a bare "element is not enabled".
 */
const submitPrompt = async (text) => {
  await page.locator("textarea.prompt-input").fill(text);
  const submit = page.locator("button.prompt-submit-button");
  const deadline = Date.now() + 15_000;
  let enabled = await submit.isEnabled();
  while (!enabled && Date.now() < deadline) {
    await page.waitForTimeout(100);
    enabled = await submit.isEnabled();
  }
  if (!enabled) {
    const model = (
      await page
        .locator(".model-picker-trigger")
        .first()
        .innerText()
        .catch(() => "(no model picker)")
    ).trim();
    const emptyMenu = await page.locator(".model-picker-empty").count();
    const preset = await page
      .locator("select.permission-selector-select")
      .inputValue()
      .catch(() => "(no selector)");
    const error = (
      await page
        .locator(".web-error")
        .first()
        .innerText()
        .catch(() => "(no error)")
    ).trim();
    throw new Error(
      "the composer never accepted " +
        JSON.stringify(text) +
        "; model=" +
        JSON.stringify(model) +
        " emptyModelMenu=" +
        emptyMenu +
        " preset=" +
        preset +
        " error=" +
        JSON.stringify(error),
    );
  }
  await submit.click();
};

/**
 * The preset the composer actually submitted, read back from the Run it created.
 *
 * The selector proves what the browser displayed and held; only the persisted Run proves what crossed
 * the wire. Sessions are matched on their title the same way the sidebar matches them, because the
 * title is derived from the prompt rather than set to an exact value.
 */
const assertSubmittedPreset = async (promptText, expectedId) => {
  const sessions = await getJson("/api/v1/sessions");
  const session = (sessions.items ?? []).find((item) =>
    String(item.title ?? "").includes(promptText),
  );
  if (session === undefined)
    throw new Error("the browser session for " + promptText + " was not persisted");
  const runs = await getJson("/api/v1/sessions/" + session.id + "/runs");
  const run = (runs.items ?? [])[0];
  if (run === undefined)
    throw new Error("the browser session for " + promptText + " created no Run");
  const actual = run.securityPolicy?.preset?.id;
  if (actual !== expectedId)
    throw new Error(
      "the composer submitted " + promptText + " under " + actual + " instead of " + expectedId,
    );
};

let smokeStage = "browser navigation";
try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  smokeStage = "initial session flow";
  await waitVisible(page.locator(".workspace-sidebar"));
  await waitVisible(page.locator(".session-scroll"));
  // Nothing is selected yet, so this is the empty landing state: the column is deliberately fixed.
  await assertViewportSplitLayout({ scrollable: false });
  await startNewSession();
  await assertPermissionSelector();
  if (s0Only) {
    smokeStage = "S0 browser heartbeat setup";
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      window.__caelushS0HeartbeatTicks = 0;
      window.setInterval(() => {
        window.__caelushS0HeartbeatTicks += 1;
      }, 25);
    });
    const heartbeatBefore = await page.evaluate(() => window.__caelushS0HeartbeatTicks ?? 0);

    smokeStage = "S0 16 KiB Tool Call stream";
    await submitPrompt("s0 streaming buffer");
    await waitVisible(page.locator("button.cancel-button"));
    await page.waitForTimeout(1_000);
    const heartbeatDuringStream = await page.evaluate(() => window.__caelushS0HeartbeatTicks ?? 0);
    if (heartbeatDuringStream <= heartbeatBefore) {
      throw new Error("the browser heartbeat stopped during the streamed Tool Call");
    }

    smokeStage = "S0 mobile sidebar button responsiveness";
    const sidebarToggle = page.locator("button.sidebar-toggle-button");
    const sidebarStateBefore = await sidebarToggle.getAttribute("aria-expanded");
    await sidebarToggle.click({ timeout: 2_000 });
    const sidebarStateDuringStream = await sidebarToggle.getAttribute("aria-expanded");
    if (sidebarStateDuringStream === sidebarStateBefore) {
      throw new Error("the sidebar button did not respond while Tool deltas were streaming");
    }
    await sidebarToggle.click({ timeout: 2_000 });

    smokeStage = "S0 heartbeat and final durable completion";
    await waitUntil(
      async () =>
        (await page.evaluate(() => window.__caelushS0HeartbeatTicks ?? 0)) >= heartbeatBefore + 2,
      "the browser heartbeat to continue during the Tool stream",
      2_000,
    );
    await waitVisible(exactText("S0 streaming regression completed."));
    await waitVisible(
      page
        .locator("button.workspace-session-item")
        .filter({ hasText: "s0 streaming buffer" })
        .locator('.session-status-icon[aria-label="已完成"]'),
    );

    await browser.close();
    process.stdout.write(
      "[browser-runner] S0 Tool stream kept the browser heartbeat and sidebar button responsive, then consumed run.completed.\n",
    );
    process.exit(0);
  }
  if (s1Only) {
    smokeStage = "S1 large Tool argument cutover";
    const assertS1DomPrivate = async (stage) => {
      const html = await page.locator("html").evaluate((node) => node.outerHTML);
      if (
        html.includes("*** Begin Patch") ||
        html.includes("S1_RAW_ARGS_SECRET_VALUE_123") ||
        html.includes('"apiKey"')
      ) {
        throw new Error(`raw Tool arguments entered the Web DOM during ${stage}`);
      }
    };
    await page.evaluate(() => {
      window.__caelushS1SawRunningEdit = false;
      const observer = new MutationObserver(() => {
        if (document.body.innerText.includes("正在编辑文件")) {
          window.__caelushS1SawRunningEdit = true;
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    });
    await submitPrompt("s1 tool argument cutover");
    await waitVisible(page.locator("button.cancel-button"));
    await openProcessDisclosure();
    await waitVisible(exactText("正在准备编辑文件"));

    smokeStage = "S1 preparation DOM privacy";
    const bodyDuringPreparation = await page.locator("body").innerText();
    const preparationRow = page.locator(".turn-presentation-live-item").filter({
      hasText: "正在准备编辑文件",
    });
    if (!(await preparationRow.isVisible())) {
      throw new Error("the Web page did not show the semantic apply_patch preparation activity");
    }
    const preparationTitle = await preparationRow.getAttribute("title");
    if (
      bodyDuringPreparation.includes("*** Begin Patch") ||
      bodyDuringPreparation.includes("S1_RAW_ARGS_SECRET_VALUE_123") ||
      bodyDuringPreparation.includes('"apiKey"') ||
      preparationTitle?.includes("*** Begin Patch") ||
      preparationTitle?.includes("S1_RAW_ARGS_SECRET_VALUE_123") ||
      preparationTitle?.includes('"apiKey"')
    ) {
      throw new Error("raw model Tool arguments or a secret-like value entered preparation text");
    }
    await assertS1DomPrivate("preparation");
    if (preparationTitle !== "正在准备编辑文件") {
      throw new Error("the preparation title attribute contains non-semantic content");
    }

    smokeStage = "S1 Tool execution handoff";
    const executionRow = page.locator('.turn-presentation-live-item[data-tool-category="EDIT"]');
    await waitUntil(async () => {
      const liveCount = await executionRow.count();
      const durableCount = await page.locator(".turn-presentation-item--tool").count();
      return liveCount > 0 || durableCount > 0;
    }, "the apply_patch invocation to take over preparation");
    const executionObservation = await page.evaluate(() => ({
      sawRunningEdit: window.__caelushS1SawRunningEdit === true,
      preparationVisible: document.body.innerText.includes("正在准备编辑文件"),
      runningEditVisible: document.body.innerText.includes("正在编辑文件"),
      rawPatchVisible: document.body.innerText.includes("*** Begin Patch"),
      secretVisible: document.body.innerText.includes("S1_RAW_ARGS_SECRET_VALUE_123"),
      liveEditCount: document.querySelectorAll(
        '.turn-presentation-live-item[data-tool-category="EDIT"]',
      ).length,
      durableToolCount: document.querySelectorAll(".turn-presentation-item--tool").length,
    }));
    if (!executionObservation.sawRunningEdit && !executionObservation.runningEditVisible) {
      throw new Error("the browser never rendered the running apply_patch Tool activity");
    }
    if (executionObservation.liveEditCount + executionObservation.durableToolCount > 1) {
      throw new Error("live and durable Tool presentation remained as duplicate rows");
    }
    if (
      executionObservation.preparationVisible ||
      executionObservation.rawPatchVisible ||
      executionObservation.secretVisible
    ) {
      throw new Error("raw Tool arguments or a stale preparation row remained during execution");
    }
    await assertS1DomPrivate("execution");

    smokeStage = "S1 completed durable Tool effect";
    await waitVisible(exactText("S1 Tool presentation completed."));
    await openProcessDisclosure();
    await waitUntil(async () => {
      const body = await page.locator("body").innerText();
      return body.includes("register.html") && body.includes("新建") && /\+\d+/u.test(body);
    }, "the completed register.html FileChange effect");
    const completedBody = await page.locator("body").innerText();
    if (completedBody.includes("正在准备编辑文件")) {
      throw new Error("the completed presentation retained the transient preparation row");
    }
    await assertS1DomPrivate("completion");

    smokeStage = "S1 durable refresh recovery";
    await page.reload({ waitUntil: "domcontentloaded" });
    await selectSession("s1 tool argument cutover");
    await openProcessDisclosure();
    await waitUntil(async () => {
      const body = await page.locator("body").innerText();
      return body.includes("register.html") && body.includes("新建") && /\+\d+/u.test(body);
    }, "the durable FileChange effect after refresh");
    const bodyAfterRefresh = await page.locator("body").innerText();
    if (bodyAfterRefresh.includes("正在准备编辑文件")) {
      throw new Error("refresh unexpectedly restored transient model preparation");
    }
    await assertS1DomPrivate("refresh");
    if ((await page.locator(".turn-presentation-item--tool").count()) !== 1) {
      throw new Error("durable ToolActivity did not restore exactly once after refresh");
    }

    await browser.close();
    process.stdout.write(
      "[browser-runner] S1 100 KiB Tool arguments stayed out of the DOM; preparation handed off to one durable ToolActivity and its FileChange effect survived refresh.\n",
    );
    process.exit(0);
  }
  if (s2Only) {
    smokeStage = "S2 frame and scroll instrumentation";
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      const scrollContainer = document.querySelector(".workspace-column");
      if (!(scrollContainer instanceof HTMLElement)) {
        throw new Error("the S2 conversation scroll container is missing");
      }
      let prototype = scrollContainer;
      let descriptor;
      while (prototype !== null && descriptor === undefined) {
        descriptor = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
        prototype = Object.getPrototypeOf(prototype);
      }
      if (descriptor?.get === undefined || descriptor.set === undefined) {
        throw new Error("the S2 scrollTop property cannot be instrumented");
      }
      const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      window.__caelushS2FrameTimestamp = undefined;
      window.__caelushS2ScrollWrites = [];
      window.requestAnimationFrame = (callback) =>
        originalRequestAnimationFrame((timestamp) => {
          window.__caelushS2FrameTimestamp = timestamp;
          callback(timestamp);
        });
      Object.defineProperty(scrollContainer, "scrollTop", {
        configurable: true,
        get: () => descriptor.get.call(scrollContainer),
        set: (value) => {
          window.__caelushS2ScrollWrites.push({
            frame: window.__caelushS2FrameTimestamp,
            value,
          });
          descriptor.set.call(scrollContainer, value);
        },
      });
    });

    smokeStage = "S2 streamed cancellation interaction";
    await submitPrompt("s2 cancel stream");
    await waitVisible(page.locator("button.cancel-button"));
    await waitUntil(
      async () => (await page.locator(".session-conversation").innerText()).includes("S2_CANCEL_"),
      "S2 cancellation stream text to appear",
    );
    await page.waitForTimeout(300);
    const nearBottomObservation = await page.evaluate(() => ({
      scrollWrites: [...(window.__caelushS2ScrollWrites ?? [])],
      scrollHeight: document.querySelector(".workspace-column")?.scrollHeight ?? 0,
      clientHeight: document.querySelector(".workspace-column")?.clientHeight ?? 0,
    }));
    if (nearBottomObservation.scrollWrites.length === 0) {
      throw new Error("near-bottom streaming did not schedule a scroll reconciliation");
    }
    const writesByFrame = new Map();
    for (const write of nearBottomObservation.scrollWrites) {
      if (write.frame === undefined) continue;
      writesByFrame.set(write.frame, (writesByFrame.get(write.frame) ?? 0) + 1);
    }
    if ([...writesByFrame.values()].some((count) => count > 1)) {
      throw new Error("streaming performed more than one scroll reconciliation in a frame");
    }
    await page.locator("button.cancel-button").click();
    await waitVisible(
      page
        .locator("button.workspace-session-item")
        .filter({ hasText: "s2 cancel stream" })
        .locator('.session-status-icon[aria-label="已取消"]'),
    );

    smokeStage = "S2 complete ordered text stream";
    await submitPrompt("s2 complete stream");
    await waitVisible(page.locator("button.cancel-button"));
    await waitUntil(
      async () => (await page.locator(".session-conversation").innerText()).length > 3_000,
      "S2 long text deltas to fill the conversation",
    );
    const userScrollTop = await page.evaluate(() => {
      const scrollContainer = document.querySelector(".workspace-column");
      if (!(scrollContainer instanceof HTMLElement)) throw new Error("scroll container missing");
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      return scrollContainer.scrollTop;
    });
    await page.waitForTimeout(300);
    const scrolledUpObservation = await page.evaluate(() => {
      const scrollContainer = document.querySelector(".workspace-column");
      if (!(scrollContainer instanceof HTMLElement)) throw new Error("scroll container missing");
      return {
        scrollTop: scrollContainer.scrollTop,
        maxScrollTop: scrollContainer.scrollHeight - scrollContainer.clientHeight,
      };
    });
    if (userScrollTop > 5 || scrolledUpObservation.scrollTop > 5) {
      throw new Error("streaming pulled a user who scrolled up back to the bottom");
    }
    if (scrolledUpObservation.maxScrollTop <= 120) {
      throw new Error("S2 text fixture did not create a meaningful scrollable history");
    }
    await waitUntil(
      async () => (await page.locator(".session-conversation").innerText()).includes("S2_COMPLETE"),
      "S2 complete answer text to appear",
    );
    await waitVisible(
      page
        .locator("button.workspace-session-item")
        .filter({ hasText: "s2 complete stream" })
        .locator('.session-status-icon[aria-label="已完成"]'),
    );
    const completedText = await page.locator(".session-conversation").innerText();
    if (!completedText.replace(/\s+/gu, " ").includes(S2_COMPLETE_TEXT.replace(/\s+/gu, " "))) {
      throw new Error("the final durable Turn does not contain every streamed text chunk");
    }
    const finalScrollTop = await page
      .locator(".workspace-column")
      .evaluate((node) => node.scrollTop);
    if (finalScrollTop > 5) {
      throw new Error("terminal publication moved a user who scrolled up back to the bottom");
    }
    await browser.close();
    process.stdout.write(
      `[browser-runner] S2 streamed cancellation stayed interactive; ordered final text and terminal state appeared; near-bottom writes=${nearBottomObservation.scrollWrites.length}, scrolled-up top=${finalScrollTop}.\n`,
    );
    process.exit(0);
  }
  if (s3Only) {
    smokeStage = "S3 hidden Provider activity DOM guard";
    await page.evaluate(() => {
      window.__caelushS3SawFalseIdle = false;
      window.__caelushS3SawProviderActive = false;
      window.__caelushS3SawSecretReasoning = false;
      const observe = () => {
        const body = document.body.innerText;
        if (body.includes("模型仍在处理")) {
          window.__caelushS3SawProviderActive = true;
        }
        if (
          window.__caelushS3SawProviderActive === true &&
          body.includes("模型近期没有返回新数据，仍在等待")
        ) {
          window.__caelushS3SawFalseIdle = true;
        }
        if (body.includes("S3_SECRET_REASONING_SENTINEL")) {
          window.__caelushS3SawSecretReasoning = true;
        }
      };
      const observer = new MutationObserver(observe);
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      window.__caelushS3Observer = observer;
    });
    await submitPrompt("s3 hidden provider activity");
    await openProcessDisclosure();
    await waitVisible(exactText("模型仍在处理"), 5_000);
    await waitVisible(exactText("S3 hidden activity completed."), 10_000);
    await waitVisible(
      page
        .locator("button.workspace-session-item")
        .filter({ hasText: "s3 hidden provider activity" })
        .locator('.session-status-icon[aria-label="已完成"]'),
    );
    const hiddenActivityObservation = await page.evaluate(() => {
      window.__caelushS3Observer?.disconnect();
      return {
        sawProviderActive: window.__caelushS3SawProviderActive === true,
        sawFalseIdle: window.__caelushS3SawFalseIdle === true,
        sawSecretReasoning: window.__caelushS3SawSecretReasoning === true,
        body: document.body.innerText,
      };
    });
    if (!hiddenActivityObservation.sawProviderActive) {
      throw new Error("the Web page did not show the hidden Provider activity state");
    }
    if (hiddenActivityObservation.sawFalseIdle) {
      throw new Error("hidden Provider activity was presented as false idle");
    }
    if (
      hiddenActivityObservation.sawSecretReasoning ||
      hiddenActivityObservation.body.includes("S3_SECRET_REASONING_SENTINEL")
    ) {
      throw new Error("hidden raw reasoning entered the Web DOM");
    }

    smokeStage = "S3 durable presentation settlement";
    await startNewSession();
    await submitPrompt("s3 durable burst");
    await waitVisible(exactText("S3 durable refresh completed."), 10_000);
    await waitVisible(
      page
        .locator("button.workspace-session-item")
        .filter({ hasText: "s3 durable burst" })
        .locator('.session-status-icon[aria-label="已完成"]'),
    );
    await openProcessDisclosure();
    await waitUntil(
      async () =>
        (await page.locator(".turn-presentation-process").innerText()).includes("fixture.txt"),
      "the completed S3 FileChange presentation",
      5_000,
    );
    await browser.close();
    process.stdout.write(
      "[browser-runner] S3 hidden Provider activity stayed live without false idle or raw reasoning; durable Tool effect and terminal presentation settled.\n",
    );
    process.exit(0);
  }
  if (multiTurnOnly) {
    smokeStage = "focused multi-turn conversation rendering";
    smokeStage = "submitting first completed Turn";
    await submitPrompt("read browser fixture");
    smokeStage = "first Turn final answer";
    await waitVisible(exactText("Browser report"));
    smokeStage = "first Run terminal status";
    await waitVisible(
      page
        .locator("button.workspace-session-item")
        .filter({ hasText: "read browser fixture" })
        .locator('.session-status-icon[aria-label="已完成"]'),
    );

    smokeStage = "submitting second completed Turn";
    await submitPrompt("multi-turn second task");
    smokeStage = "second Turn final answer";
    await waitVisible(exactText("Verified browser result."));
    smokeStage = "second Run terminal status";
    await waitVisible(
      page
        .locator("button.workspace-session-item")
        .filter({ hasText: "read browser fixture" })
        .locator('.session-status-icon[aria-label="已完成"]'),
    );
    const turns = page.locator(".turn-presentation-turn");
    smokeStage = "two canonical Turns rendered";
    await waitUntil(async () => (await turns.count()) === 2, "two independent presentation Turns");
    const firstTurn = turns.nth(0);
    const secondTurn = turns.nth(1);
    smokeStage = "Turn 1 and Turn 2 ownership";
    if (
      !(await firstTurn.locator(".turn-presentation-item--user").innerText()).includes(
        "read browser fixture",
      )
    ) {
      throw new Error("the first Run user prompt is not inside Turn 1");
    }
    if (
      !(await secondTurn.locator(".turn-presentation-item--user").innerText()).includes(
        "multi-turn second task",
      )
    ) {
      throw new Error("the second Run user prompt is not inside Turn 2");
    }
    if (
      !(await firstTurn.locator(".turn-presentation-final").innerText()).includes("Browser report")
    ) {
      throw new Error("Turn 1 final answer is not inside Turn 1");
    }
    if (
      !(await secondTurn.locator(".turn-presentation-final").innerText()).includes(
        "Verified browser result.",
      )
    ) {
      throw new Error("Turn 2 final answer is not inside Turn 2");
    }
    const firstSummary = firstTurn.locator("details.turn-presentation-process > summary");
    const secondSummary = secondTurn.locator("details.turn-presentation-process > summary");
    smokeStage = "Turn-local collapse state";
    await firstSummary.click();
    await waitUntil(
      () => firstTurn.locator("details.turn-presentation-process").evaluate((node) => node.open),
      "Turn 1 process to expand",
    );
    if (
      await secondTurn.locator("details.turn-presentation-process").evaluate((node) => node.open)
    ) {
      throw new Error("expanding Turn 1 also expanded Turn 2");
    }
    await secondSummary.click();
    await waitUntil(
      () => secondTurn.locator("details.turn-presentation-process").evaluate((node) => node.open),
      "Turn 2 process to expand",
    );
    await firstSummary.click();
    await waitUntil(
      () => firstTurn.locator("details.turn-presentation-process").evaluate((node) => !node.open),
      "Turn 1 process to collapse",
    );
    if (!(await firstTurn.locator(".turn-presentation-final").isVisible())) {
      throw new Error("collapsing Turn 1 hid its Final answer");
    }
    if (
      !(await secondTurn.locator("details.turn-presentation-process").evaluate((node) => node.open))
    ) {
      throw new Error("collapsing Turn 1 changed Turn 2's expanded state");
    }
    const conversationText = await page.locator(".session-conversation").innerText();
    if (
      !(
        conversationText.indexOf("Browser report") <
        conversationText.indexOf("multi-turn second task")
      )
    ) {
      throw new Error("the second User prompt appears before the first Turn final answer");
    }

    smokeStage = "submitting active Tool Turn";
    await submitPrompt("multi-turn patch fixture");
    smokeStage = "active Run control";
    await waitVisible(page.locator("button.cancel-button"));
    smokeStage = "durable structured Tool row";
    const activeTurn = turns.nth(2);
    try {
      await waitVisible(activeTurn.locator('[data-tool-category="EDIT"]'));
    } catch (error) {
      const evidence = await activeTurn.evaluate((element) => ({
        runStatus: element.getAttribute("data-run-status"),
        items: Array.from(
          element.querySelectorAll(".turn-presentation-item, .turn-presentation-live-item"),
        ).map((item) => ({
          className: item.className,
          category: item.getAttribute("data-tool-category"),
          text: item.textContent?.slice(0, 500),
        })),
      }));
      throw new Error(
        "Active Turn has no EDIT Tool Activity: " + JSON.stringify(evidence) + "; " + error.message,
      );
    }
    smokeStage = "structured File effect";
    await waitVisible(
      activeTurn.locator(".turn-presentation-tool-effects").filter({ hasText: "fixture.txt" }),
    );
    smokeStage = "Live and durable invocation reconciliation";
    await waitUntil(
      async () => (await activeTurn.locator("[data-tool-invocation-id]").count()) === 1,
      "the durable Tool row to reconcile its live invocation",
    );
    smokeStage = "historical Turn live-state isolation";
    if (
      (await firstTurn.locator(".turn-presentation-live, .turn-presentation-thinking").count()) !==
      0
    ) {
      throw new Error("the active Run's live state leaked into a historical Turn");
    }
    if (
      (await secondTurn.locator(".turn-presentation-live, .turn-presentation-thinking").count()) !==
      0
    ) {
      throw new Error("the active Run's live state leaked into a historical Turn");
    }
    if (
      !(await activeTurn.locator(".turn-presentation-item--tool").innerText()).includes(
        "fixture.txt",
      )
    ) {
      throw new Error("the completed Tool effect is missing from the active Turn process");
    }

    smokeStage = "cancel active Tool Turn";
    await page.locator("button.cancel-button").click();
    smokeStage = "cancelled Run status";
    await waitUntil(
      async () => (await activeTurn.getAttribute("data-run-status")) === "CANCELLED",
      "the active Turn to settle as CANCELLED",
    );
    smokeStage = "cancelled Run summary and retained File effect";
    await waitVisible(activeTurn.locator(".turn-presentation-item--run-summary"));
    await activeTurn.locator("details.turn-presentation-process > summary").click();
    await waitUntil(
      () => activeTurn.locator("details.turn-presentation-process").evaluate((node) => node.open),
      "cancelled Turn process to expand",
    );
    if (
      !(await activeTurn.locator(".turn-presentation-item--tool").innerText()).includes(
        "fixture.txt",
      )
    ) {
      throw new Error("cancelling the Run hid its already completed File effect");
    }

    await context.close();
    await browser.close();
    process.stdout.write(
      "[browser-runner] focused multi-turn rendering, isolation, Tool effects, and collapse checks passed.\n",
    );
    process.exit(0);
  }
  await submitPrompt("read browser fixture");
  await waitVisible(exactText("Verified browser result."));
  await assertSubmittedPreset("read browser fixture", "WORKSPACE_WRITE");
  // The disclosure auto-collapses the instant the Run settles, so the settled report is the signal
  // that the collapse has already happened and the expansion below will stick.
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "read browser fixture" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );
  await openProcessDisclosure();
  // The presentation feed replaces the legacy timeline: a finished Tool is an item, and the path it
  // touched belongs to that item's own summary text rather than to its own element.
  await waitVisible(
    page
      .locator(".turn-presentation-item--tool .turn-presentation-item-label")
      .filter({ hasText: "读取文件" }),
  );
  await waitVisible(
    page
      .locator(".turn-presentation-item--tool .turn-presentation-item-text")
      .filter({ hasText: "fixture.txt" }),
  );
  await assertTaskTimerSummaryLayout({ mobile: false });
  const completedTaskElapsed = await page
    .locator(".turn-presentation-summary-copy .turn-presentation-task-elapsed")
    .first()
    .textContent();
  await page.waitForTimeout(1_200);
  if (
    (await page
      .locator(".turn-presentation-summary-copy .turn-presentation-task-elapsed")
      .first()
      .textContent()) !== completedTaskElapsed
  ) {
    throw new Error("the completed task elapsed timer did not freeze");
  }
  if ((await page.locator(".session-list-meta").count()) !== 0)
    throw new Error("status subtitle leaked");
  if ((await page.locator(".session-status-icon").count()) < 1)
    throw new Error("status icon missing");
  if ((await page.locator('.session-status-icon[aria-label="已完成"]').count()) !== 1)
    throw new Error("completed status missing");

  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("read browser fixture");
  smokeStage = "completed transcript rendering";
  await waitVisible(exactText("Verified browser result."));
  await assertAssistantMarkdownHeadingScale();
  await assertPermissionSelectorAppearance();
  await page.setViewportSize({ width: 1440, height: 900 });
  smokeStage = "durable Context Usage refresh";
  const contextUsageButton = page.locator("button.context-usage-ring-button");
  await waitUntil(
    async () =>
      (await contextUsageButton.getAttribute("aria-label")) !== "工作上下文用量：暂无数据",
    "the durable Context Usage projection to load",
  );
  smokeStage = "opening Context Usage inspector";
  await contextUsageButton.click();
  const cacheInspector = page.locator(".context-inspector");
  await waitVisible(cacheInspector);
  smokeStage = "checking prompt-cache facts";
  for (const label of [
    "平台实际命中率",
    "Caelush 可复用前缀效率",
    "缓存周期",
    "最近重置",
    "未上报 usage",
  ]) {
    if (!(await cacheInspector.innerText()).includes(label)) {
      throw new Error("prompt-cache inspector is missing " + label);
    }
  }
  if (!(await cacheInspector.innerText()).includes("未上报 usage")) {
    throw new Error("fixture Provider usage was incorrectly displayed as a reported rate");
  }
  const cacheSection = cacheInspector.locator(".context-cache-section");
  smokeStage = "capturing desktop cache inspector";
  await cacheSection.screenshot({ path: artifactDirectory + "/prompt-cache-desktop.png" });
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileSidebarToggle = page.locator(".sidebar-toggle-button");
  if ((await mobileSidebarToggle.getAttribute("aria-expanded")) === "true") {
    await mobileSidebarToggle.click();
  }
  await page.waitForTimeout(220);
  smokeStage = "checking mobile cache overflow";
  const cacheBounds = await cacheInspector.boundingBox();
  const viewportBounds = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
  }));
  if (
    cacheBounds === null ||
    cacheBounds.x < 0 ||
    cacheBounds.x + cacheBounds.width > viewportBounds.width + 1
  ) {
    smokeStage = "mobile prompt-cache panel bounds outside viewport";
    throw new Error("prompt-cache inspector overflows the 375px mobile viewport");
  }
  if (cacheBounds.y < 0 || cacheBounds.y + cacheBounds.height > viewportBounds.height + 1) {
    smokeStage = `mobile inspector vertical bounds y=${cacheBounds.y}, height=${cacheBounds.height}, viewport=${viewportBounds.height}`;
    throw new Error("prompt-cache inspector exceeds the 375px mobile viewport height");
  }
  if (viewportBounds.documentWidth > viewportBounds.width + 1) {
    smokeStage = "mobile document horizontal overflow";
    throw new Error("prompt-cache inspector overflows the 375px mobile viewport");
  }
  await cacheSection.screenshot({ path: artifactDirectory + "/prompt-cache-mobile.png" });
  if (promptCacheOnly) {
    await context.close();
    await browser.close();
    process.stdout.write("[browser-runner] prompt-cache desktop/mobile checks passed.\n");
    process.exit(0);
  }
  await contextUsageButton.click();
  await page.setViewportSize({ width: 375, height: 812 });
  if ((await mobileSidebarToggle.getAttribute("aria-expanded")) === "true") {
    await mobileSidebarToggle.click();
  }
  await page.waitForTimeout(220);
  await assertAssistantMarkdownHeadingScale();
  await assertComposerControlsDoNotOverlap();
  await page.setViewportSize({ width: 1280, height: 720 });

  smokeStage = "Provider recovery flow";
  await startNewSession();
  await submitPrompt("observe Provider recovery");
  await openProcessDisclosure();
  const noActivity = page
    .locator(".turn-presentation-thinking-detail")
    .filter({ hasText: "模型近期没有返回新数据，仍在等待" });
  await waitVisible(noActivity);
  const activeTaskElapsed = page
    .locator(".turn-presentation-summary-copy .turn-presentation-task-elapsed")
    .first();
  await waitVisible(activeTaskElapsed);
  const activeElapsedBefore = await activeTaskElapsed.textContent();
  await waitUntil(
    async () => (await activeTaskElapsed.textContent()) !== activeElapsedBefore,
    "active task elapsed timer to advance",
    3_000,
  );
  const thinkingTitle = page.locator(".turn-presentation-thinking-title").last();
  const animationName = () =>
    thinkingTitle.evaluate((element) => getComputedStyle(element).animationName);
  await waitUntil(
    async () => (await animationName()) === "turn-presentation-thinking-text",
    "animated model-wait text",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await waitUntil(async () => (await animationName()) === "none", "reduced-motion model-wait text");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const retryScheduled = page
    .locator(".turn-presentation-thinking-detail")
    .filter({ hasText: /将在 \d+ 秒后重新连接 1\/5/u });
  await waitVisible(retryScheduled);
  await waitVisible(exactText("正在重新连接 1/5"));
  await waitUntil(
    async () => (await animationName()) === "turn-presentation-thinking-text",
    "animated retry text",
  );
  await waitVisible(exactText("Recovered after Provider recovery."));
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("observe Provider recovery");
  await waitVisible(exactText("Recovered after Provider recovery."));
  if ((await page.locator("body").innerText()).includes("failed-attempt fragment")) {
    throw new Error("failed-attempt Provider text leaked into the durable session transcript");
  }

  // In-workspace work does not cross the boundary, so 工作区内修改 must not interrupt it with a review.
  // This is the negative half of the approval contract and the reason the scenarios below need an
  // action the gate genuinely cannot describe.
  smokeStage = "workspace edit flow";
  await startNewSession();
  await submitPrompt("apply browser patch");
  await waitVisible(exactText("Verified browser result.").last());
  if ((await page.locator(".approval-card").count()) !== 0) {
    throw new Error("an in-workspace patch under 工作区内修改 was gated behind an approval");
  }
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "apply browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );
  await openProcessDisclosure();
  // `apply_patch` is labelled 编辑文件 by the Tool presentation the Daemon projects (the legacy web
  // timeline had its own 修改文件 label, which is what this assertion used to look for).
  await waitVisible(
    page
      .locator(".turn-presentation-item--tool .turn-presentation-item-label")
      .filter({ hasText: "编辑文件" })
      .last(),
  );
  // The review a completed Run goes through is a verification item, not the legacy timeline's
  // free-text "Verification passed." row.
  await waitVisible(page.locator(".turn-presentation-item--verification").last());
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "apply browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  // An escaping patch cannot be described by the facts projector, so `ON_BOUNDARY` answers it with a
  // review request — and the card has to survive a reload, because it is the durable Run's state and
  // not page state. Approving it resumes the Run, and the workspace boundary still refuses the write.
  await startNewSession();
  await submitPrompt("review browser patch");
  await waitVisible(exactText("需要审批"));
  await waitVisible(page.locator(".approval-card"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("review browser patch");
  await waitVisible(page.locator(".approval-card"));
  await page.locator("button.approval-action--approve_once").click();
  await page.locator(".approval-card").waitFor({ state: "detached", timeout: 15_000 });
  await waitVisible(exactText("Verified browser result.").last());
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "review browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );
  await openProcessDisclosure();
  await waitVisible(
    page
      .locator(".turn-presentation-item--tool.turn-presentation-item--failed")
      .filter({ hasText: "编辑文件" })
      .last(),
  );
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "review browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await startNewSession();
  await submitPrompt("reject browser patch");
  await waitVisible(exactText("需要审批"));
  await waitVisible(page.locator(".approval-card"));
  await page.locator("button.approval-action--reject").click();
  await exactText("需要审批").waitFor({ state: "hidden", timeout: 15_000 });
  await waitVisible(exactText("Verified browser result.").last());
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "reject browser patch" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await startNewSession();
  await submitPrompt("cancel browser task");
  await waitVisible(page.locator("button.cancel-button"));
  await page.locator("button.cancel-button").click();
  await waitVisible(page.locator('.session-status-icon[aria-label="已取消"]').last());

  const reconnectSession = await postJson("/api/v1/sessions", {
    title: "reconnect browser task",
    defaultWorkspace: workspace,
    defaultModel: { provider: "browser-fixture", model: "browser-fixture-model" },
    metadata: {},
  });
  const reconnectRun = await postJson("/api/v1/sessions/" + reconnectSession.id + "/runs", {
    goal: "reconnect browser task",
    workspace,
    model: { provider: "browser-fixture", model: "browser-fixture-model" },
    runtime: { id: "local", kind: "local" },
    // The Run contract is preset-based. `permissionProfile` and `approvalPolicy` are not accepted by
    // `CreateRunRequestSchema` (it is strict and requires `preset`), so sending them answered HTTP 400
    // and the whole reconnect scenario never started.
    preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 120_000 },
  });
  await postJson("/api/v1/runs/" + reconnectRun.id + "/start", {});
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("reconnect browser task");
  await waitVisible(page.locator("button.cancel-button"));
  // A live Run keeps its process disclosure expanded and reports the active state. That is the
  // presentation feed's equivalent of the legacy timeline's per-entry "Model" row, which no longer
  // exists now that the feed owns the execution view.
  await waitVisible(
    page.locator(".turn-presentation-summary-status").filter({ hasText: /正在执行|进行中/ }),
  );
  await waitVisible(page.locator(".turn-presentation-body"));
  await page.locator("button.cancel-button").click();
  await waitVisible(page.locator('.session-status-icon[aria-label="已取消"]').last());

  const session = await postJson("/api/v1/sessions", {
    title: "pending browser task",
    defaultWorkspace: workspace,
    defaultModel: { provider: "browser-fixture", model: "browser-fixture-model" },
    metadata: {},
  });
  await postJson("/api/v1/sessions/" + session.id + "/runs", {
    goal: "pending browser task",
    workspace,
    model: { provider: "browser-fixture", model: "browser-fixture-model" },
    runtime: { id: "local", kind: "local" },
    preset: { id: "WORKSPACE_WRITE", expectedVersion: 1 },
    limits: { maxSteps: 8, maxToolCalls: 8, timeoutMs: 120_000 },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await selectSession("pending browser task");
  await waitVisible(page.locator(".recovery-panel"));
  await page.locator(".recovery-run button").click();
  await waitVisible(exactText("Verified browser result.").last());
  await waitVisible(
    page
      .locator("button.workspace-session-item")
      .filter({ hasText: "pending browser task" })
      .locator('.session-status-icon[aria-label="已完成"]'),
  );

  await page.setViewportSize({ width: 375, height: 812 });
  // Every scenario above left turns behind, so the column must own the rail again.
  await assertViewportSplitLayout({ scrollable: true });
  await page.locator(".sidebar-toggle-button").click();
  if ((await page.locator(".sidebar-toggle-button").getAttribute("aria-expanded")) !== "true")
    throw new Error("sidebar did not open");
  await page.locator(".sidebar-backdrop").click({ position: { x: 350, y: 120 } });
  if ((await page.locator(".sidebar-toggle-button").getAttribute("aria-expanded")) !== "false")
    throw new Error("sidebar did not close");
  await page.waitForTimeout(220);
  const body = await page.locator("body").innerText();
  if (!body.includes("pending browser task")) throw new Error("pending recovery title missing");
  await assertTaskTimerSummaryLayout({ mobile: true });
  for (const forbidden of ["Inspector", "Terminal", "stdout"]) {
    if (body.includes(forbidden)) throw new Error(forbidden + " leaked into production UI");
  }
  await page.locator(".workspace-card").first().hover();
  await page.waitForTimeout(220);
  const tooltipStyle = await page
    .locator(".workspace-card")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
        width: style.width,
      };
    });
  if (tooltipStyle.backgroundColor !== "rgb(30, 79, 133)")
    throw new Error("workspace path tooltip is not solid blue");
} catch (error) {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  throw new Error(
    `Browser fixture smoke failed during ${smokeStage}: ${error instanceof Error ? error.message : "unknown error"}; page content and screenshots were suppressed.`,
  );
}
await context.close();
await browser.close();

async function assertAssistantMarkdownHeadingScale() {
  const title = page.getByRole("heading", { name: "Browser report", level: 1 });
  await waitVisible(title);
  const sizes = await title.evaluate((element) => {
    const section = element.parentElement?.querySelector("h2");
    if (!(section instanceof HTMLElement)) throw new Error("Markdown section heading missing");
    return {
      title: Number.parseFloat(getComputedStyle(element).fontSize),
      section: Number.parseFloat(getComputedStyle(section).fontSize),
    };
  });
  if (sizes.title <= sizes.section || sizes.title > sizes.section * 1.4) {
    throw new Error(
      `Markdown report title should be only slightly larger than its section heading; title=${sizes.title}px section=${sizes.section}px`,
    );
  }
}

async function assertPermissionSelectorAppearance() {
  const select = page.locator("select.permission-selector-select");
  const appearance = await select.evaluate((element) => ({
    appearance: getComputedStyle(element).appearance,
    width: element.getBoundingClientRect().width,
  }));
  if (appearance.appearance !== "auto")
    throw new Error("permission selector lost its native dropdown affordance");
  if (appearance.width < 120)
    throw new Error("permission selector is too narrow to present its choices clearly");
}

async function assertComposerControlsDoNotOverlap() {
  const controls = page.locator(".model-picker-trigger");
  const submit = page.locator(".prompt-submit-button");
  const bounds = await Promise.all([controls.boundingBox(), submit.boundingBox()]);
  if (!bounds[0] || !bounds[1]) throw new Error("composer controls are not visible");
  if (bounds[0].x + bounds[0].width > bounds[1].x) {
    throw new Error("model picker overlaps the send button at the mobile viewport");
  }
}

async function assertTaskTimerSummaryLayout({ mobile }) {
  const summary = page.locator(".turn-presentation-summary").first();
  await waitVisible(summary);
  const layout = await summary.evaluate((element) => {
    const logo = element.querySelector(".turn-presentation-logo");
    const elapsed = element.querySelector(".turn-presentation-task-elapsed");
    const status = element.querySelector(".turn-presentation-summary-status");
    if (!(logo instanceof HTMLElement)) throw new Error("process logo missing");
    if (!(elapsed instanceof HTMLElement)) throw new Error("task elapsed timer missing");
    if (!(status instanceof HTMLElement)) throw new Error("process status missing");
    const logoBounds = logo.getBoundingClientRect();
    const elapsedBounds = elapsed.getBoundingClientRect();
    const statusBounds = status.getBoundingClientRect();
    return {
      direction: getComputedStyle(elapsed.parentElement).flexDirection,
      gap: Number.parseFloat(getComputedStyle(elapsed.parentElement).columnGap),
      logoRight: logoBounds.right,
      elapsedLeft: elapsedBounds.left,
      elapsedRight: elapsedBounds.right,
      statusLeft: statusBounds.left,
      viewportWidth: window.innerWidth,
      elapsedText: elapsed.textContent,
    };
  });
  if (layout.direction !== "row") throw new Error("task timer is not on the logo row");
  const actualGap = layout.elapsedLeft - layout.logoRight;
  if (actualGap < 6 || actualGap > 20) {
    throw new Error("task timer spacing beside the logo is not moderate: " + actualGap + "px");
  }
  if (layout.gap < 6 || layout.gap > 16)
    throw new Error("task summary gap is outside the intended compact range: " + layout.gap + "px");
  if (layout.elapsedRight >= layout.statusLeft)
    throw new Error("task elapsed timer overlaps the process status");
  if (mobile && layout.elapsedRight > layout.viewportWidth)
    throw new Error("task elapsed timer overflows the mobile viewport");
  if (!/^用时 (?:\d+小时)?(?:\d+分)?\d+秒$/u.test(layout.elapsedText ?? ""))
    throw new Error("task elapsed timer has an unexpected label: " + layout.elapsedText);
}
