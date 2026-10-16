import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
const entry = `
import { StrictMode,useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountArchiveEntry } from "./src/renderer/components/account-archive-screen.tsx";
const one = "wsp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b", parent = "wsp_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c";
const sid = "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b", child = "ses_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9c";
const episode = {archiveId:"00000000-0000-4000-8000-000000000000",archivedAt:null,reason:"USER"};
let items = [{sessionId:sid,title:"中文 空格 %_",archivedAt:null,state:{target:{type:"SESSION",sessionId:sid},archived:true,ownArchive:episode,restoreDisposition:"AVAILABLE"},group:{key:one,workspaceId:one,displayName:"项目一",canonicalPath:"D:/项目一",matchedCount:1}}, {sessionId:child,title:"随父工作区归档",archivedAt:null,state:{target:{type:"SESSION",sessionId:child},archived:true,parentWorkspace:{workspaceId:parent,archive:episode},restoreDisposition:"PARENT_ARCHIVED"},group:{key:parent,workspaceId:parent,displayName:"父项目",canonicalPath:"D:/父项目",matchedCount:1}}];
let workspaces = [{workspace:{id:parent,displayName:"父项目",canonicalPath:"D:/父项目",createdAt:1,updatedAt:1,lastOpenedAt:1},state:{target:{type:"WORKSPACE",workspaceId:parent},archived:true,ownArchive:episode,restoreDisposition:"AVAILABLE"},archivedAt:null,sessionCount:1}];
const confirmations = new Map();
window.archiveTest = {calls:[],pending:[],identity:"one",paused:false,fetches:0};
window.fetch = async()=>{window.archiveTest.fetches++;throw new Error("generic fetch forbidden");};
const counts = ()=>({sessions:items.length,workspaces:workspaces.length});
const api = {capabilityVersion:1,
 listSessions:async(query)=>{window.archiveTest.calls.push({method:"listSessions",query,identity:window.archiveTest.identity});const data = window.archiveTest.identity === "two" ? [{...items[0],title:"另一个账号"}] : items;const filtered = data.filter(i=>(!query.query||i.title.includes(query.query))&&(!query.workspaceId||i.group.workspaceId===query.workspaceId));const result={items:filtered,matchedCount:filtered.length,totalCounts:counts(),catalogRevision:1};if(window.archiveTest.paused&&window.archiveTest.identity==="one")return new Promise(resolve=>window.archiveTest.pending.push(()=>resolve(result)));return result;},
 listWorkspaces:async(query)=>({items:workspaces.filter(i=>!query.query||i.workspace.displayName.includes(query.query)),matchedCount:workspaces.length,totalCounts:counts(),catalogRevision:1}),
 getState:async(target)=>{const state=target.type==="SESSION"?items.find(i=>i.sessionId===target.sessionId)?.state:workspaces.find(i=>i.workspace.id===target.workspaceId)?.state;if(!state)throw Object.assign(new Error("missing"),{code:"NOT_FOUND"});return state;},
 archive:async()=>{throw new Error("history must never archive");},
 restore:async(input)=>{window.archiveTest.calls.push({method:"restore",input});if(input.target.type==="WORKSPACE"){workspaces=workspaces.filter(i=>i.workspace.id!==input.target.workspaceId);items=items.filter(i=>i.state.parentWorkspace?.workspaceId!==input.target.workspaceId);}else items=items.filter(i=>i.sessionId!==input.target.sessionId);return {changed:true,state:{target:input.target,archived:false,restoreDisposition:"NOT_ARCHIVED"},catalogRevision:2};},
 previewDeletion:async(selection)=>{const token="confirmed:"+confirmations.size;confirmations.set(token,selection);window.archiveTest.calls.push({method:"preview",selection});return {counts:{workspaces:selection.type.startsWith("WORKSPACE")?workspaces.length:0,sessions:selection.type==="SESSION"?1:items.length,runs:3},samples:[{type:"SESSION",label:"中文 空格 %_"}],confirmationToken:token,expiresAt:Date.now()+600000};},
 permanentlyDelete:async(input)=>{window.archiveTest.calls.push({method:"delete",input});const selection=confirmations.get(input.confirmationToken);if(selection.type==="SESSION")items=items.filter(i=>i.sessionId!==selection.sessionId);else if(selection.type==="SESSION_FILTER")items=items.filter(i=>selection.filter.query&&!i.title.includes(selection.filter.query));else {items=[];workspaces=[];}return {counts:{workspaces:0,sessions:1,runs:3},catalogRevision:2};},
 readTranscript:async(input)=>{window.archiveTest.calls.push({method:"history",input});const common={runId:"run_0192f5b1-4d3a-7c2e-8a91-3f0b6c7d8e9b",conversationTurnId:"turn",createdAt:1};return input.query?.cursor?{items:[{...common,id:"page-two",kind:"USER",text:"第二页历史"}]}:{items:[{...common,id:"user",kind:"USER",text:"用户正文"},{...common,id:"assistant",kind:"ASSISTANT",phase:"FINAL_ANSWER",text:"公开答复"},{...common,id:"custom",kind:"CUSTOM",presentationType:"fixture",label:"公开标签",text:"公开扩展正文",metadata:{private:"hidden-metadata-marker"}},{...common,id:"tool",kind:"TOOL_RESULT",toolCallId:"tool",toolName:"read_file",text:"公开工具摘要",isError:false},{...common,id:"terminal",kind:"RUN_TERMINAL",status:"COMPLETED",text:"运行已结束"}],nextCursor:"next"};}
};
function Harness(){const [identity,setIdentity]=useState("one"),[missing,setMissing]=useState(false);window.archiveTest.switchIdentity=(key)=>{window.archiveTest.identity=key;setIdentity(key);};window.archiveTest.missing=()=>setMissing(true);return <AccountArchiveEntry api={missing?undefined:api} identityKey={identity} onMutation={()=>window.archiveTest.calls.push({method:"mutation"})}/>;}
createRoot(document.getElementById("root")).render(<StrictMode><Harness/></StrictMode>);
`;
describe.skipIf(!existsSync(chromium.executablePath()))("Desktop account archive view", () => {
  let browser: Browser;
  let page: Page;
  let bundle: string;
  let styles: string;
  beforeAll(async () => {
    const output = await build({
      stdin: { contents: entry, resolveDir: desktopRoot, loader: "tsx" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    bundle = output.outputFiles[0]!.text;
    styles = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
    browser = await chromium.launch({ headless: true });
  }, 30000);
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(3000);
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: styles });
    await page.addScriptTag({ content: bundle });
    await page.getByRole("button", { name: "中文 空格 %_", exact: true }).waitFor();
  });
  afterEach(async () => {
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
  });
  it("centers grouped rows, preserves literal spaces, and fits a narrow Desktop window", async () => {
    expect(await page.getByText("归档时间未知", { exact: false }).count()).toBe(2);
    const box = await page.locator(".archive-page").boundingBox();
    expect(Math.abs(box!.x + box!.width / 2 - 640)).toBeLessThan(2);
    await page.getByRole("searchbox").fill("中文 空格 %_");
    await page.waitForTimeout(320);
    expect(await page.getByRole("button", { name: "中文 空格 %_", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "随父工作区归档", exact: true }).count()).toBe(0);
    await page.setViewportSize({ width: 800, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
  it("opens safe paged history without any restore or sending controls", async () => {
    await page.getByRole("button", { name: "中文 空格 %_", exact: true }).click();
    await page.getByText("公开扩展正文", { exact: true }).waitFor();
    expect(await page.locator("textarea").count()).toBe(0);
    expect(await page.locator("body").innerText()).not.toContain("hidden-metadata-marker");
    await page.getByRole("button", { name: "加载更多历史" }).click();
    await page.getByText("第二页历史", { exact: true }).waitFor();
    expect(
      await page.evaluate(
        () => window.archiveTest.calls.filter((c) => c.method === "restore").length,
      ),
    ).toBe(0);
    await page.getByRole("button", { name: "返回已归档" }).click();
  });
  it("guides explicit parent restoration and confirms a token-only bulk deletion", async () => {
    await page.getByRole("button", { name: "先恢复工作区" }).click();
    await page.getByRole("button", { name: "恢复工作区", exact: true }).click();
    expect(
      await page.evaluate(
        () => window.archiveTest.calls.find((c) => c.method === "restore").input.target.type,
      ),
    ).toBe("WORKSPACE");
    await page.getByRole("tab", { name: /会话/ }).click();
    const trigger = page.getByRole("button", { name: "彻底删除会话", exact: true }).first();
    await trigger.click();
    const cancel = page.getByRole("button", { name: "取消", exact: true });
    await cancel.waitFor();
    expect(await cancel.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("alertdialog").count()).toBe(0);
    expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.getByRole("button", { name: /删除全部已归档会话/ }).click();
    await page.getByRole("button", { name: "彻底删除", exact: true }).click();
    await page.getByText("暂无已归档会话", { exact: true }).waitFor();
    expect(
      await page.evaluate(() =>
        Object.keys(window.archiveTest.calls.find((c) => c.method === "delete").input),
      ),
    ).toEqual(["confirmationToken"]);
  });
  it("clears old history, tokens and late responses at an account identity change", async () => {
    await page.getByRole("button", { name: "彻底删除会话", exact: true }).first().click();
    await page.getByRole("alertdialog").waitFor();
    await page.evaluate(() => {
      window.archiveTest.paused = true;
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(() => window.archiveTest.pending.length > 0);
    await page.evaluate(() => window.archiveTest.switchIdentity("two"));
    await page.getByRole("button", { name: "另一个账号", exact: true }).waitFor();
    await page.evaluate(() => window.archiveTest.pending.splice(0).forEach((release) => release()));
    expect(await page.getByRole("alertdialog").count()).toBe(0);
    expect(await page.getByRole("button", { name: "中文 空格 %_", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "另一个账号", exact: true }).count()).toBe(1);
  });
  it("shows an upgrade message for a missing bridge without using generic fetch", async () => {
    await page.evaluate(() => window.archiveTest.missing());
    await page.getByRole("alert").filter({ hasText: "重建或更新" }).waitFor();
    expect(await page.evaluate(() => window.archiveTest.fetches)).toBe(0);
  });
});
