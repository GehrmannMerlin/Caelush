import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const model = { provider: "deepseek", model: "deepseek-chat" };
export const answer = "归档验收：这是一条公开答复，项目代码与 Git 历史会保留。";

export async function createSmokeRoot() {
  const root = path.resolve(tmpdir(), `caelush-archive-smoke-${randomUUID()}`);
  await mkdir(root);
  return root;
}

export async function removeSmokeRoot(root) {
  const absolute = path.resolve(root);
  assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
  assert.match(path.basename(absolute), /^caelush-archive-smoke-[0-9a-f-]{36}$/u);
  await rm(absolute, { recursive: true, force: true });
}

export async function createProjects(root) {
  const projects = [
    path.join(root, "中文 项目 A"),
    path.join(root, "保留代码 项目 B"),
    path.join(root, "删除记录保留项目 C"),
  ];
  for (const project of projects) {
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(
      path.join(project, "src", "hello.ts"),
      "export const greeting = '你好 archive';\n",
    );
    await writeFile(path.join(project, "binary.dat"), Buffer.from([0, 255, 128, 13, 10, 97]));
    for (const argv of [
      ["init", "--quiet"],
      ["config", "user.name", "Archive Fixture"],
      ["config", "user.email", "archive@example.invalid"],
      ["add", "."],
      ["commit", "--quiet", "-m", "fixture project history"],
    ])
      execFileSync("git", argv, { cwd: project, windowsHide: true, stdio: "ignore" });
  }
  return projects;
}

export async function inventory(projects) {
  const files = {};
  async function walk(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = path.join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(absolute, relative);
      else {
        assert.equal(entry.isFile(), true, "Fixture inventory only contains ordinary files");
        files[relative] = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
      }
    }
  }
  for (let i = 0; i < projects.length; i++) await walk(projects[i], String(i));
  return files;
}

export async function startModelFixture() {
  const server = createServer(async (request, response) => {
    for await (const chunk of request) assert.ok(Buffer.isBuffer(chunk));
    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: model.model, object: "model", owned_by: "fixture" }],
        }),
      );
      return;
    }
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunk = (delta, finishReason = null) => ({
      id: "archive-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: model.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: answer }))}\n\n`);
    response.write(
      `data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export async function until(read, predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}; last result ${JSON.stringify(value)}`);
}

export async function seedArchiveFixture(client, projects) {
  const a = await client.createWorkspace({ path: projects[0], displayName: "中文项目 A" });
  const b = await client.createWorkspace({ path: projects[1], displayName: "归档工作区 B" });
  const c = await client.createWorkspace({ path: projects[2], displayName: "待删除工作区 C" });
  const create = (workspace, title) => client.createSession({ workspaceId: workspace.id, title });
  const runInput = (workspace) => ({
    goal: "请给出一条简短的公开答复。",
    model,
    workspace: { id: workspace.id, path: workspace.canonicalPath },
    runtime: { id: "local", kind: "local" },
    preset: { id: "FULL_ACCESS", expectedVersion: 1 },
    limits: { maxSteps: 3, maxToolCalls: 3, timeoutMs: 30_000 },
  });
  async function completed(workspace, title) {
    const session = await create(workspace, title);
    const run = await client.createRun(session.id, runInput(workspace));
    await client.startRun(run.id);
    const terminal = await until(
      () => client.getRun(run.id),
      (run) => ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status),
      "fixture Run terminal",
    );
    assert.equal(terminal.status, "COMPLETED", "Fixture must produce real completed transcript");
    assert.ok(
      (await client.getSessionTranscript(session.id)).items.some((item) =>
        item.text?.includes(answer),
      ),
    );
    return { sessionId: session.id, runId: run.id };
  }
  const alpha = await completed(a, "独立归档 · 公开历史");
  const retained = await completed(a, "正常会话 · 必须保留");
  await client.archiveSession(alpha.sessionId);
  const beta = await create(b, "随工作区归档 · 先恢复父级");
  const independent = await create(b, "子会话独立归档 · 恢复父级后仍保留");
  await client.archiveSession(independent.id);
  const pending = await create(a, "运行结束前不能归档");
  const pendingRun = await client.createRun(pending.id, runInput(a));
  await assert.rejects(
    client.archiveSession(pending.id),
    (error) => error.code === "ACTIVE_RUN_CONFLICT",
  );
  await client.cancelRun(pendingRun.id);
  await until(
    () => client.getRun(pendingRun.id),
    (run) => run.status === "CANCELLED",
    "pending cancellation",
  );
  const episode = await client.archiveSession(pending.id);
  await client.restoreSession(pending.id, { archiveId: episode.state.ownArchive.archiveId });
  const bulkIds = [];
  for (let index = 0; index < 105; index++) {
    const session = await create(
      a,
      `筛选 %_ ${String(index).padStart(3, "0")} · 长标题用于检查省略行为 ${"内容".repeat(12)}`,
    );
    bulkIds.push(session.id);
    await client.archiveSession(session.id);
  }
  const parent = await client.archiveWorkspace(b.id);
  const cSession = await create(c, "删除工作区的子会话");
  await client.archiveWorkspace(c.id);
  return {
    a,
    b,
    c,
    cSessionId: cSession.id,
    alpha,
    retained,
    betaId: beta.id,
    independentId: independent.id,
    bulkIds,
    parentArchiveId: parent.state.ownArchive.archiveId,
  };
}

export function databaseEvidence(databasePath, fixture) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    function runGraph(runId) {
      const counts = {};
      for (const table of tables) {
        assert.match(table, /^[a-z0-9_]+$/u);
        const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
        if (columns.some((column) => column.name === "run_id"))
          counts[table] = db
            .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE run_id = ?`)
            .get(runId).count;
      }
      counts.runs = db
        .prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE id = ?")
        .get(runId).count;
      return counts;
    }
    return {
      alpha: runGraph(fixture.alpha.runId),
      retained: runGraph(fixture.retained.runId),
      targetSession: db
        .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE id = ?")
        .get(fixture.alpha.sessionId).count,
      bulkSessions: fixture.bulkIds.reduce(
        (sum, id) =>
          sum +
          db.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE id = ?").get(id).count,
        0,
      ),
      foreignKeyCheck: db.prepare("PRAGMA foreign_key_check").all(),
      purgedWorkspaceSessions: db
        .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE workspace_id = ?")
        .get(fixture.c.id).count,
      purgedWorkspaceArchive: db
        .prepare("SELECT COUNT(*) AS count FROM workspace_archives WHERE workspace_id = ?")
        .get(fixture.c.id).count,
    };
  } finally {
    db.close();
  }
}

/** Identical visible interactions against real HTTP Web and the real preload-backed account UI. */
export async function exerciseArchivePage(page, artifacts, native = false, nativeScreenshot) {
  const { expect } = await import("@playwright/test");
  const screenshot = (name) =>
    nativeScreenshot
      ? nativeScreenshot(name)
      : page.screenshot({ path: path.join(artifacts, name), fullPage: true });
  await expect(page.getByRole("heading", { name: "已归档", exact: true })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "搜索已归档会话" });
  await expect(search).toBeVisible();
  const archivePage = page.locator(".archive-page");
  const scrollLayout = await archivePage.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const contentBounds = element.querySelector(".archive-page-content").getBoundingClientRect();
    const before = element.scrollTop;
    element.scrollTop = element.scrollHeight;
    return {
      left: bounds.left,
      right: bounds.right,
      viewportWidth: globalThis.innerWidth,
      contentLeft: contentBounds.left,
      contentRight: contentBounds.right,
      contentCenter: (contentBounds.left + contentBounds.right) / 2,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      windowScrollY: globalThis.scrollY,
      overflowY: globalThis.getComputedStyle(element).overflowY,
      before,
    };
  });
  assert.ok(
    scrollLayout.left <= 1 && scrollLayout.right >= scrollLayout.viewportWidth - 1,
    "Archive page scroll region must span the viewport so its scrollbar stays at the far right",
  );
  assert.ok(
    scrollLayout.contentRight - scrollLayout.contentLeft <= 945 &&
      scrollLayout.contentLeft >= 0 &&
      scrollLayout.contentRight <= scrollLayout.viewportWidth &&
      Math.abs(scrollLayout.contentCenter - scrollLayout.viewportWidth / 2) <= 16,
    "Archive content must remain centered within its 944px maximum width",
  );
  assert.equal(scrollLayout.overflowY, "auto", "Archive page owns vertical scrolling");
  assert.ok(
    scrollLayout.scrollHeight > scrollLayout.clientHeight && scrollLayout.scrollTop > 0,
    "Archive page must scroll through the full session list",
  );
  assert.equal(
    scrollLayout.windowScrollY,
    0,
    "The document itself must not become a scroll region",
  );
  await expect(page.getByRole("button", { name: "加载更多", exact: true })).toBeInViewport();
  await archivePage.evaluate((element) => {
    element.scrollTop = 0;
  });
  await search.fill("独立归档 · 公开历史");
  await expect(page.locator(".archive-row")).toHaveCount(1);
  const row = page.locator(".archive-row");
  await row.getByRole("button", { name: "独立归档 · 公开历史", exact: true }).click();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  assert.equal(await page.locator("textarea").count(), 0, "Archived history has no composer");
  await screenshot("history-readonly.png");
  await page.getByRole("button", { name: "返回已归档" }).click();
  const trash = page.getByRole("button", { name: "彻底删除会话", exact: true });
  await trash.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "彻底删除", exact: true })).toBeEnabled();
  await screenshot("delete-confirmation.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trash).toBeFocused();
  await trash.click();
  await dialog.getByRole("button", { name: "彻底删除", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("没有找到匹配结果", { exact: true })).toBeVisible();
  await search.fill("%_");
  await expect(page.getByRole("button", { name: "删除筛选结果", exact: true })).toBeEnabled();
  await expect(page.locator(".archive-row")).toHaveCount(50);
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator(".archive-row")).toHaveCount(100);
  await screenshot("filtered-pagination.png");
  await page.getByRole("button", { name: "删除筛选结果", exact: true }).click();
  await expect(dialog.getByText(/105 个会话/)).toBeVisible();
  await dialog.getByRole("button", { name: "彻底删除", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("没有找到匹配结果", { exact: true })).toBeVisible();
  await search.fill("");
  await expect(page.locator(".archive-row")).toHaveCount(3);
  await page
    .locator(".archive-row")
    .filter({ hasText: "随工作区归档 · 先恢复父级" })
    .getByRole("button", { name: "先恢复工作区" })
    .click();
  await expect(page.getByRole("tab", { name: "工作区", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "恢复工作区" })).toBeVisible();
  await screenshot("workspaces.png");
  await page.getByRole("button", { name: "恢复工作区" }).click();
  await expect(page.locator(".archive-workspace-row")).toHaveCount(0);
  await expect(page.locator(".archive-empty")).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索已归档工作区" }).fill("");
  await expect(page.locator(".archive-workspace-row")).toHaveCount(1);
  await page.getByRole("button", { name: "彻底删除工作区", exact: true }).click();
  await expect(dialog.getByText(/1 个工作区记录及其 1 个会话/)).toBeVisible();
  await dialog.getByRole("button", { name: "彻底删除", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".archive-workspace-row")).toHaveCount(0);
  await page.getByRole("tab", { name: "会话", exact: true }).click();
  await expect(page.locator(".archive-row")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "子会话独立归档 · 恢复父级后仍保留", exact: true }),
  ).toBeVisible();
  const bounds = await page.locator(".archive-delete-icon").first().boundingBox();
  assert.ok(bounds.width >= 32 && bounds.height >= 32, "Action target must be at least 32px");
  await screenshot("archive-final.png");
  if (native) await page.evaluate(() => globalThis.window.scrollTo(0, 0));
  return {
    singleDeletion: true,
    workspaceDeletion: true,
    all105MatchingDeleted: true,
    loadedRowsBeforeBulk: 100,
    readOnly: true,
    parentRestore: true,
    independentArchiveRetained: true,
    keyboard: true,
  };
}

export async function verifyWorkspaceReRegistration(client, fixture) {
  await assert.rejects(client.getWorkspace(fixture.c.id), (error) => error.code === "NOT_FOUND");
  const registered = await client.createWorkspace({ path: fixture.c.canonicalPath });
  assert.equal(registered.id, fixture.c.id);
  assert.equal((await client.listWorkspaceSessions(registered.id)).items.length, 0);
  assert.equal(
    (await client.getArchiveState({ type: "WORKSPACE", workspaceId: registered.id })).archived,
    false,
  );
  await assert.rejects(
    client.getSession(fixture.cSessionId),
    (error) => error.code === "NOT_FOUND",
  );
}
