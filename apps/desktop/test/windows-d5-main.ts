import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  app,
  protocol,
  safeStorage,
  session,
  webContents,
  type BrowserWindow,
  type WebContents,
} from "electron";
import { DpapiVault } from "../src/main/credentials/vault.js";
import {
  accountVaultKey,
  generateDeviceIdentity,
  writeActiveAccount,
  type StoredAccountRecord,
} from "../src/main/credentials/device-identity.js";
import { ProviderCredentialVault } from "../src/main/credentials/provider-credential-vault.js";
import { DesktopLegacyDataImporter } from "../src/main/migration/legacy-data-import.js";
import { DesktopProviderCredentialMigrator } from "../src/main/migration/provider-credential-migration.js";
import { DesktopDaemonSupervisor } from "../src/main/daemon/supervisor.js";
import { resolveDesktopDaemonResources } from "../src/main/daemon/resources.js";
import { DesktopLocalProxy } from "../src/main/protocol/local-proxy.js";
import { registerAppProtocol } from "../src/main/protocol/app-protocol.js";
import { AccountController, type CloudAccountPort } from "../src/main/account/controller.js";
import { canonicalizeJcs } from "../src/main/offline/grant.js";
import {
  ProfileManager,
  WindowsProfilePermissions,
  profileIdForUser,
} from "../src/main/profiles/profile-manager.js";
import { DesktopWorkspacePanelController } from "../src/main/workspace/panel-controller.js";
import { registerDesktopIpc } from "../src/main/ipc/handlers.js";
import { createMainWindow } from "../src/main/windows/create-window.js";
import type { AccountState } from "../src/main/account/state.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "caelush-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: "caelush-login",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const testRoot = requiredEnvironment("CAELUSH_D5_TEST_ROOT");
const desktopRoot = requiredEnvironment("CAELUSH_D5_DESKTOP_APP_ROOT");
const localAppDataRoot = requiredEnvironment("LOCALAPPDATA");
const markerPath = path.join(testRoot, "d5-smoke.marker");
const workspaceAPath = path.join(testRoot, "workspace-account-a");
const workspaceA2Path = path.join(testRoot, "workspace-account-a-secondary");
const workspaceBPath = path.join(testRoot, "workspace-account-b");
const outsidePath = path.join(testRoot, "outside-workspace");
const userA = randomUUID();
const userB = randomUUID();
const emailA = "d5-a@example.invalid";
const emailB = "d5-b@example.invalid";
const providerId = "deepseek";
const modelId = "deepseek-chat";
const providerKey = "d5-scripted-provider-fixture-key";
const markerLines: string[] = [];
const chatCalls: string[] = [];
const terminalOutputText = new Map<string, string>();
let failureStage = "INITIALIZE";
let fixture: ReturnType<typeof createServer> | undefined;
let supervisor: DesktopDaemonSupervisor | undefined;
let panels: DesktopWorkspacePanelController | undefined;
let mainWindow: BrowserWindow | undefined;
let disposeIpc: (() => void) | undefined;
let account: AccountController | undefined;
let vault: DpapiVault | undefined;

app.whenReady().then(async () => {
  try {
    setFailureStage("TEST_WORKSPACES");
    await Promise.all([
      mkdir(workspaceAPath, { recursive: true }),
      mkdir(workspaceA2Path, { recursive: true }),
      mkdir(workspaceBPath, { recursive: true }),
      mkdir(outsidePath, { recursive: true }),
      mkdir(localAppDataRoot, { recursive: true }),
    ]);
    await mkdir(path.join(workspaceAPath, "src"), { recursive: true });
    await writeFile(
      path.join(workspaceAPath, "src", "hello.ts"),
      "export const greeting = 'D5_你好';\n",
      "utf8",
    );
    await writeFile(path.join(workspaceAPath, "large.txt"), Buffer.alloc(1_048_577, 0x61));
    await writeFile(path.join(outsidePath, "secret.txt"), "must not be previewed");
    await writeFile(path.join(workspaceA2Path, "secondary.txt"), "D5_SECONDARY_WORKSPACE", "utf8");
    await writeFile(path.join(workspaceBPath, "account-b.txt"), "D5_ACCOUNT_B", "utf8");
    await symlink(outsidePath, path.join(workspaceAPath, "outside-junction"), "junction");
    recordMarker("WORKSPACE_FIXTURES=PASS");

    fixture = createServer((request, response) => void handleProviderRequest(request, response));
    await listen(fixture);
    const providerAddress = fixture.address() as AddressInfo;
    const providerOrigin = `http://127.0.0.1:${providerAddress.port}/v1`;
    process.env.CAELUSH_PROVIDER_ID = providerId;
    process.env.CAELUSH_PROVIDER_BASE_URL = providerOrigin;
    process.env.CAELUSH_DEFAULT_PROVIDER = providerId;
    process.env.CAELUSH_DEFAULT_MODEL = modelId;
    process.env.CAELUSH_PROVIDER_API_KEY = providerKey;

    vault = new DpapiVault(path.join(app.getPath("userData"), "credentials.dpapi"), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptStringAsync: (value) => safeStorage.encryptStringAsync(value),
      decryptStringAsync: async (value) =>
        (await safeStorage.decryptStringAsync(Buffer.from(value))).result,
    });
    await vault.initialize();
    const trustedKeyPair = generateKeyPairSync("ed25519");
    const trustedSpki = trustedKeyPair.publicKey.export({ format: "der", type: "spki" });
    const trustedRawKey = Buffer.from(trustedSpki).subarray(-32);
    await seedOfflineAccount(vault, {
      email: emailA,
      userId: userA,
      deviceId: randomUUID(),
      signingKey: trustedKeyPair.privateKey,
    });
    account = new AccountController({
      vault,
      cloud: createFixtureCloud(trustedKeyPair.privateKey) as CloudAccountPort,
      trustedOfflinePublicKeys: { d5_fixture_key: trustedRawKey },
    });
    await account.initialize();
    assert.equal(account.getState().status, "AUTHORIZED_OFFLINE");

    const profileManager = new ProfileManager({
      localAppDataDirectory: localAppDataRoot,
      platform: "win32",
      permissions: new WindowsProfilePermissions("win32", process.env),
    });
    const credentialVault = new ProviderCredentialVault(vault);
    const credentialMigrator = new DesktopProviderCredentialMigrator({
      vault,
      credentials: credentialVault,
    });
    const legacyImporter = new DesktopLegacyDataImporter({
      profileManager,
      vault,
      credentialMigrator,
      assertAuthorized: (cloudUserId) => {
        const state = account!.getState();
        if (
          (state.status !== "AUTHENTICATED_ONLINE" && state.status !== "AUTHORIZED_OFFLINE") ||
          state.account?.userId !== cloudUserId
        ) {
          throw new Error("The fixture account changed during legacy data inspection.");
        }
      },
    });
    supervisor = new DesktopDaemonSupervisor({
      profileManager,
      credentialVault,
      credentialMigrator,
      resolveResources: () =>
        resolveDesktopDaemonResources({
          packaged: false,
          appPath: desktopRoot,
          resourcesPath: process.resourcesPath,
        }),
      productVersion: "0.1.0",
      processEnvironment: process.env,
    });
    await supervisor.synchronizeAccountState(account.getState());
    assert.notEqual(supervisor.getActiveProfileIdentity(), null);
    const proxy = new DesktopLocalProxy({
      acquireLease: (signal) => supervisor!.acquireProxyLease(signal),
    });
    const connected = await localApi(proxy, `/api/v1/ai/providers/${providerId}/connect`, {
      method: "POST",
      body: { apiKey: providerKey },
    });
    assert.equal(provider(connected.value, providerId).credentialSource, "LOCAL");
    assert.equal(JSON.stringify(connected.value).includes(providerKey), false);
    const workspaceA = await createWorkspace(proxy, workspaceAPath, "D5 Account A Workspace");
    const workspaceA2 = await createWorkspace(proxy, workspaceA2Path, "D5 Account A Secondary");
    recordMarker("OFFLINE_GRANT_DAEMON_PROVIDER_WORKSPACES=PASS");

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    registerAppProtocol({
      rendererRoot: path.join(desktopRoot, "dist", "renderer"),
      agentRoot: path.resolve(desktopRoot, "..", "web", "dist", "desktop"),
      localProxy: proxy,
      isAgentAvailable: () => supervisor!.getAgentEntry(account!.getState()).available,
    });
    mainWindow = createMainWindow({
      appPath: desktopRoot,
      preloadPath: path.join(desktopRoot, "dist", "preload", "index.cjs"),
      rendererTrust: { developmentOrigin: null },
    });
    mainWindow.webContents.on("console-message", (_event, details) => {
      if (details.level >= 2) {
        process.stderr.write(
          `D5_RENDERER_CONSOLE=${details.message.slice(0, 512)} (${details.sourceId}:${details.lineNumber})\n`,
        );
      }
    });
    mainWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame) {
          process.stderr.write(
            `D5_RENDERER_LOAD_FAILED=${errorCode}:${errorDescription}:${validatedURL}\n`,
          );
        }
      },
    );
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      process.stderr.write(`D5_RENDERER_PROCESS_GONE=${details.reason}:${details.exitCode}\n`);
    });
    panels = new DesktopWorkspacePanelController({
      window: mainWindow,
      supervisor,
      resourceLayout: {
        packaged: false,
        appPath: desktopRoot,
        resourcesPath: process.resourcesPath,
      },
      onTerminalOutput: (ownerId, output) => {
        if (output.data !== undefined) {
          terminalOutputText.set(
            output.terminalId,
            `${terminalOutputText.get(output.terminalId) ?? ""}${output.data}`,
          );
        }
        if (ownerId === mainWindow?.webContents.id && isAgentWindow(mainWindow)) {
          mainWindow.webContents.send("caelush:workspace:terminal:output", output);
        }
      },
      onBrowserState: (ownerId, state) => {
        if (ownerId === mainWindow?.webContents.id && isAgentWindow(mainWindow)) {
          mainWindow.webContents.send("caelush:browser:state", state);
        }
      },
    });
    disposeIpc = registerDesktopIpc({
      window: mainWindow,
      controller: account,
      rendererTrust: { developmentOrigin: null },
      platform: process.platform,
      arch: process.arch,
      version: "0.1.0",
      projectAccountState: (state) => ({ ...state, agentEntry: supervisor!.getAgentEntry(state) }),
      beginAccountBoundary: async () => {
        await panels?.closeAll();
        await supervisor?.beginAccountBoundary();
      },
      synchronizeAccountState: (state) => supervisor!.synchronizeAccountState(state),
      legacyImporter,
      desktopPanels: panels,
    });
    await waitFor(
      () => mainWindow!.webContents.getURL().startsWith("caelush-login://app/"),
      "Login Renderer",
    );
    await waitFor(
      () => mainWindow!.webContents.isLoadingMainFrame() === false,
      "Login Renderer load",
    );

    setFailureStage("LOAD_AGENT_UI");
    await mainWindow.loadURL("caelush-app://app/agent/");
    await waitForRenderer(
      mainWindow.webContents,
      "window.caelushDesktop !== undefined",
      "Agent Preload",
    );
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('textarea[aria-label=\"任务输入\"]') !== null",
      "Agent UI",
    );
    await waitForRenderer(
      mainWindow.webContents,
      "[...document.querySelectorAll('.workspace-list-button')].some(button=>button.textContent?.includes('D5 Account A Workspace'))",
      "registered Workspace in Agent UI",
    );
    await clickWorkspace(mainWindow.webContents, "D5 Account A Workspace");
    const selectedWorkspaceName = await execute(
      mainWindow.webContents,
      "document.querySelector('.workspace-list-item--selected .workspace-list-copy strong')?.textContent",
    );
    assert.equal(selectedWorkspaceName, "D5 Account A Workspace");
    await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.activate({workspaceId:${JSON.stringify(workspaceA.id)}})`,
    );
    const selectedWorkspaceEntries = await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.listEntries({workspaceId:${JSON.stringify(workspaceA.id)},relativePath:'',offset:0,limit:200})`,
    );
    assert.ok(
      selectedWorkspaceEntries.items.some(
        (entry: { readonly name: string }) => entry.name === "src",
      ),
    );
    const desktopNamespaces = await execute(
      mainWindow.webContents,
      "Object.keys(window.caelushDesktop).sort()",
    );
    assert.deepEqual(desktopNamespaces, [
      "account",
      "browser",
      "legacyData",
      "update",
      "window",
      "workspace",
    ]);
    assert.equal(
      await execute(mainWindow.webContents, "typeof window.process + ':' + typeof window.require"),
      "undefined:undefined",
    );
    assert.equal(
      await execute(
        mainWindow.webContents,
        `JSON.stringify(window.caelushDesktop).includes(${JSON.stringify(providerKey)})`,
      ),
      false,
    );
    const availability = await execute(
      mainWindow.webContents,
      "window.caelushDesktop.workspace.getAvailability()",
    );
    assert.deepEqual(availability, { available: true });
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('[aria-label=\"展开桌面面板\"]') !== null",
      "collapsed Desktop panel",
    );
    await click(mainWindow.webContents, 'button[aria-label="展开桌面面板"]');
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('[aria-label=\"收起桌面面板\"]') !== null",
      "expanded Desktop panel",
    );
    await waitForRenderer(
      mainWindow.webContents,
      "[...document.querySelectorAll('[role=treeitem]')].some(item=>item.textContent?.includes('src'))",
      "selected Workspace in Files panel",
    );
    await waitForRenderer(
      mainWindow.webContents,
      "[...document.querySelectorAll('[role=treeitem]')].some(item=>item.textContent?.includes('src'))",
      "selected Workspace in Files panel",
    );
    await execute(
      mainWindow.webContents,
      `(()=>{const panel=document.querySelector('.desktop-workspace-panel');const grip=document.querySelector('.desktop-panel-resize-grip');if(!panel||!grip)throw new Error('panel resize grip missing');grip.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:5,clientX:window.innerWidth-340}));window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:5,clientX:window.innerWidth-300}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:5,clientX:window.innerWidth-300}));return true})()`,
    );
    await waitForRenderer(
      mainWindow.webContents,
      "Math.abs(parseFloat(document.querySelector('.desktop-workspace-panel')?.style.width ?? '0')-300)<2",
      "drag-resized Desktop panel",
    );
    assert.equal(
      await execute(
        mainWindow.webContents,
        "getComputedStyle(document.querySelector('.desktop-file-preview')).overflowY",
      ),
      "auto",
    );
    await clickByText(mainWindow.webContents, "button[role=treeitem]", "src");
    await waitForRenderer(
      mainWindow.webContents,
      "document.body.innerText.includes('hello.ts')",
      "expanded Workspace directory tree",
    );
    await clickByText(mainWindow.webContents, "button[role=treeitem]", "hello.ts");
    await waitForRenderer(
      mainWindow.webContents,
      "document.body.innerText.includes('D5_你好')",
      "Chinese UTF-8 preview",
    );

    setFailureStage("FILE_AUTHORITY");
    const filePage = await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.listEntries({workspaceId:${JSON.stringify(workspaceA.id)},relativePath:'',offset:0,limit:200})`,
    );
    assert.ok(
      filePage.items.some(
        (entry: { name: string; kind: string }) =>
          entry.name === "outside-junction" && entry.kind === "SYMLINK",
      ),
    );
    const largeResult = await rendererCall(
      mainWindow.webContents,
      `(async()=>{try{await window.caelushDesktop.workspace.previewText({workspaceId:${JSON.stringify(workspaceA.id)},relativePath:'large.txt'});return 'unexpected'}catch(error){return error.message}})()`,
    );
    assert.equal(largeResult, "This file is too large to preview.");
    const traversalResult = await rendererCall(
      mainWindow.webContents,
      `(async()=>{try{await window.caelushDesktop.workspace.previewText({workspaceId:${JSON.stringify(workspaceA.id)},relativePath:'../outside-workspace/secret.txt'});return 'unexpected'}catch(error){return error.message}})()`,
    );
    assert.equal(traversalResult, "The Workspace path contains an unsupported segment.");
    const junctionResult = await rendererCall(
      mainWindow.webContents,
      `(async()=>{try{await window.caelushDesktop.workspace.previewText({workspaceId:${JSON.stringify(workspaceA.id)},relativePath:'outside-junction/secret.txt'});return 'unexpected'}catch(error){return error.message}})()`,
    );
    assert.equal(junctionResult, "Workspace links are not followed by the Desktop file browser.");
    recordMarker("FILE_TREE_UTF8_SIZE_TRAVERSAL_JUNCTION=PASS");

    setFailureStage("IDE_RESOLVER");
    const editors = await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.listEditors({workspaceId:${JSON.stringify(workspaceA.id)}})`,
    );
    assert.ok(
      Array.isArray(editors) &&
        editors.every((editor: { id: string }) => ["vscode", "cursor"].includes(editor.id)),
    );
    const injectedEditorInput = await rendererCall(
      mainWindow.webContents,
      `(async()=>{try{await window.caelushDesktop.workspace.openInEditor({editorId:'vscode',workspaceId:${JSON.stringify(workspaceA.id)},executablePath:'cmd.exe',command:'whoami'});return 'unexpected'}catch(error){return error.message}})()`,
    );
    assert.equal(injectedEditorInput, "The desktop request did not match the supported input.");
    const installedEditor = editors[0] as { readonly id: "vscode" | "cursor" } | undefined;
    if (installedEditor !== undefined) {
      const opened = await rendererCall(
        mainWindow.webContents,
        `window.caelushDesktop.workspace.openInEditor({editorId:${JSON.stringify(installedEditor.id)},workspaceId:${JSON.stringify(workspaceA.id)},relativeFilePath:'src/hello.ts'})`,
      );
      assert.deepEqual(opened, { opened: true, editorId: installedEditor.id });
      recordMarker(`IDE_OPEN=PASS:${installedEditor.id}`);
    } else {
      const unavailable = await rendererCall(
        mainWindow.webContents,
        `(async()=>{try{await window.caelushDesktop.workspace.openInEditor({editorId:'vscode',workspaceId:${JSON.stringify(workspaceA.id)}});return 'unexpected'}catch(error){return error.message}})()`,
      );
      assert.equal(unavailable, "This editor is not installed.");
      recordMarker("IDE_OPEN=UNAVAILABLE:no-supported-editor-installed");
    }

    setFailureStage("AGENT_RUN_SSE");
    const fullAccessOption = await execute(
      mainWindow.webContents,
      `(()=>{const select=document.querySelector('select[aria-label="选择权限"]');const option=[...select?.options??[]].find(item=>item.value==='FULL_ACCESS');return Boolean(option&&!option.disabled)})()`,
    );
    assert.equal(
      fullAccessOption,
      true,
      "The isolated text-only fixture needs an available permission preset.",
    );
    await execute(
      mainWindow.webContents,
      `(()=>{const select=document.querySelector('select[aria-label="选择权限"]');if(!select)throw new Error('Permission selector missing');select.value='FULL_ACCESS';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    );
    await waitForRenderer(
      mainWindow.webContents,
      "[...document.querySelectorAll('[role=dialog] button')].some(button=>button.textContent?.includes('确认使用完全权限'))",
      "explicit Full Access confirmation for text-only fixture",
    );
    await clickByText(mainWindow.webContents, "[role=dialog] button", "确认使用完全权限");
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('select[aria-label=\"选择权限\"]')?.value==='FULL_ACCESS'",
      "confirmed fixture permission",
    );
    recordMarker("AGENT_RUN_PERMISSION=FULL_ACCESS_CONFIRMED_TEXT_ONLY_PROVIDER_FIXTURE");
    await click(
      mainWindow.webContents,
      ".workspace-list-item--selected .workspace-new-session-button",
    );
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('button[aria-label=\"发送任务\"]')?.disabled === false",
      "ready Agent composer",
    );
    await setTextArea(mainWindow.webContents, "D5 real Electron UI fixture run");
    await click(mainWindow.webContents, 'button[aria-label="发送任务"]');
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('.active-run-status') !== null",
      "live Agent Run status",
    );
    await click(mainWindow.webContents, "button[role=tab]:nth-child(2)");
    await click(mainWindow.webContents, "button[role=tab]:nth-child(1)");
    await waitForRenderer(
      mainWindow.webContents,
      "document.body.innerText.includes('The local D5 Electron fixture run completed.')",
      "SSE-driven Agent completion",
      90_000,
    );
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('.desktop-file-preview')?.innerText.includes('D5_你好') === true",
      "Files preview retained after tab changes",
    );
    const workspaceAProfile = await profileManager.selectForUser(userA);
    const runCountsBeforeTerminal = readRunCounts(workspaceAProfile.databasePath);
    assert.ok(chatCalls.length >= 1);
    recordMarker("REAL_AGENT_UI_RUN_SSE_PANEL_TOGGLE=PASS");

    setFailureStage("BROWSER_GUEST_A");
    await clickByText(mainWindow.webContents, "button[role=tab]", "浏览器");
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('input[aria-label=\"浏览器网址\"]') !== null",
      "Browser panel controls",
    );
    let browserLeaseA = await ensureBrowserGuestLease(mainWindow.webContents);
    assert.match(browserLeaseA, /^[A-Za-z0-9_-]{43}$/u);
    recordMarker("BROWSER_GUEST_MAIN_LEASE=PASS");
    await setInputValue(
      mainWindow.webContents,
      'input[aria-label="浏览器网址"]',
      "https://example.com/",
    );
    await click(mainWindow.webContents, 'button[aria-label="导航"]');
    let guestA = await waitForGuest("https://example.com/");
    recordMarker("BROWSER_GUEST_HTTPS_NAVIGATION=PASS");
    const browserAfterNavigation = await execute(
      guestA,
      "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,text:document.body?.innerText?.slice(0,160)})",
    );
    const browserMain = (
      panels as unknown as {
        browser: { guest?: { readonly errorCode?: string; readonly loading: boolean } };
      }
    ).browser;
    recordMarker(
      `BROWSER_PAGE=${JSON.stringify({ page: browserAfterNavigation, state: browserMain.guest === undefined ? null : { errorCode: browserMain.guest.errorCode, loading: browserMain.guest.loading } })}`,
    );
    assert.equal(
      await execute(
        guestA,
        "typeof window.process + ':' + typeof window.require + ':' + typeof window.caelushDesktop",
      ),
      "undefined:undefined:undefined",
    );
    assert.equal(await execute(guestA, "document.title"), "Example Domain");
    assert.equal(
      await execute(
        guestA,
        "document.body.innerText.includes('This domain is for use in documentation examples')",
      ),
      true,
    );
    await execute(guestA, "document.cookie='d5_profile=account_a; Max-Age=3600; Path=/'");
    const cookieA = await execute(guestA, "document.cookie");
    assert.match(cookieA, /d5_profile=account_a/u);
    recordMarker("BROWSER_GUEST_ISOLATION_AND_COOKIE=PASS");
    await setInputValue(
      mainWindow.webContents,
      'input[aria-label="浏览器网址"]',
      "https://example.com/?d5=second",
    );
    await click(mainWindow.webContents, 'button[aria-label="导航"]');
    guestA = await waitForGuest("https://example.com/?d5=second");
    await click(mainWindow.webContents, 'button[aria-label="后退"]');
    await waitFor(
      () => guestA!.getURL() === "https://example.com/",
      "Browser Guest back navigation",
    );
    await click(mainWindow.webContents, 'button[aria-label="前进"]');
    await waitFor(
      () => guestA!.getURL() === "https://example.com/?d5=second",
      "Browser Guest forward navigation",
    );
    let guestLoadCount = 0;
    const onGuestLoadStart = () => {
      guestLoadCount += 1;
    };
    guestA.on("did-start-loading", onGuestLoadStart);
    const previousGuestLoadCount = guestLoadCount;
    await click(mainWindow.webContents, 'button[aria-label="刷新"]');
    await waitFor(
      () =>
        guestLoadCount > previousGuestLoadCount &&
        guestA!.getURL() === "https://example.com/?d5=second" &&
        !guestA!.isLoading(),
      "Browser Guest reload",
    );
    guestA.removeListener("did-start-loading", onGuestLoadStart);
    await setInputValue(
      mainWindow.webContents,
      'input[aria-label="浏览器网址"]',
      "file:///C:/Windows/win.ini",
    );
    await click(mainWindow.webContents, 'button[aria-label="导航"]');
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('.desktop-panel-error')?.textContent==='Enter a public HTTPS website address.'",
      "unsafe Browser URL rejection",
    );
    const [contentWidth = 0] = mainWindow.getContentSize();
    const guestBounds = findBrowserViewBounds(mainWindow, guestA);
    assert.ok(guestBounds.x >= Math.floor(contentWidth * 0.64));
    assert.ok(guestBounds.x + guestBounds.width <= contentWidth);
    await mainWindow.setSize(1040, 720);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const [resizedContentWidth = 0] = mainWindow.getContentSize();
    const resizedGuestBounds = findBrowserViewBounds(mainWindow, guestA);
    assert.ok(resizedGuestBounds.x >= Math.floor(resizedContentWidth * 0.64));
    assert.ok(resizedGuestBounds.x + resizedGuestBounds.width <= resizedContentWidth);
    await mainWindow.setSize(1120, 760);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await click(mainWindow.webContents, 'button[aria-label="关闭浏览器"]');
    await waitFor(() => guestA!.isDestroyed(), "Browser Guest close control");
    const closedBrowserLeaseA = browserLeaseA;
    browserLeaseA = await ensureBrowserGuestLease(mainWindow.webContents);
    assert.notEqual(browserLeaseA, closedBrowserLeaseA);
    await setInputValue(
      mainWindow.webContents,
      'input[aria-label="浏览器网址"]',
      "https://example.com/",
    );
    await click(mainWindow.webContents, 'button[aria-label="导航"]');
    guestA = await waitForGuest("https://example.com/");
    assert.match(await execute(guestA, "document.cookie"), /d5_profile=account_a/u);
    recordMarker("WEB_CONTENTS_VIEW_HTTPS_HISTORY_SANDBOX_PROFILE_A=PASS");

    setFailureStage("USER_TERMINAL_A");
    const powershellBefore = new Set(readPowerShellProcessIds());
    await click(mainWindow.webContents, "button[role=tab]:nth-child(2)");
    await clickByText(mainWindow.webContents, ".desktop-terminal button", "打开 PowerShell");
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('.desktop-terminal')?.innerText.includes('关闭终端') === true",
      "USER_TERMINAL PowerShell",
      25_000,
    );
    const powershellAfterCreate = new Set(readPowerShellProcessIds());
    const terminalPowerShellIds = difference(powershellAfterCreate, powershellBefore);
    assert.ok(
      terminalPowerShellIds.length > 0,
      "ConPTY did not create a Windows PowerShell process.",
    );
    const terminalManager = (
      panels as unknown as {
        terminalRuntime: { sessions: Map<string, { readonly child: { readonly pid?: number } }> };
      }
    ).terminalRuntime;
    const firstTerminal = [...terminalManager.sessions.entries()][0];
    assert.ok(firstTerminal !== undefined);
    const [terminalIdA, terminalRecordA] = firstTerminal;
    const terminalHelperPidA = terminalRecordA.child.pid;
    assert.ok(Number.isInteger(terminalHelperPidA) && terminalHelperPidA! > 0);
    const terminalCwd = String(
      await execute(
        mainWindow.webContents,
        "document.querySelector('.desktop-terminal-cwd')?.textContent",
      ),
    );
    assert.equal(
      path.resolve(terminalCwd).toLowerCase(),
      path.resolve(workspaceA.canonicalPath).toLowerCase(),
    );
    await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.terminal.resize({terminalId:${JSON.stringify(terminalIdA)},cols:104,rows:31})`,
    );
    await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.terminal.write({terminalId:${JSON.stringify(terminalIdA)},data:${JSON.stringify("Write-Output 'D5_UTF8_中文_OK'\r")}})`,
    );
    await waitFor(
      () => terminalOutputFor(panels, terminalIdA).includes("D5_UTF8_中文_OK"),
      "ConPTY Unicode output",
      15_000,
    );
    await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.terminal.write({terminalId:${JSON.stringify(terminalIdA)},data:${JSON.stringify("Start-Sleep -Seconds 30\r")}})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.terminal.write({terminalId:${JSON.stringify(terminalIdA)},data:${JSON.stringify("\u0003")}})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.workspace.terminal.write({terminalId:${JSON.stringify(terminalIdA)},data:${JSON.stringify("Write-Output 'D5_CTRL_C_RECOVERED'\r")}})`,
    );
    await waitFor(
      () => terminalOutputFor(panels, terminalIdA).includes("D5_CTRL_C_RECOVERED"),
      "ConPTY Ctrl+C recovery",
      10_000,
    );
    assert.deepEqual(readRunCounts(workspaceAProfile.databasePath), runCountsBeforeTerminal);
    recordMarker("NODE_24_NODE_PTY_CONPTY_UTF8_RESIZE_CTRL_C_RUN_ISOLATION=PASS");

    setFailureStage("WORKSPACE_SWITCH");
    await rendererCall(
      mainWindow.webContents,
      `window.caelushDesktop.browser.setBounds({leaseId:${JSON.stringify(browserLeaseA)},bounds:null})`,
    );
    recordMarker("WORKSPACE_SWITCH_GUEST_HIDDEN=PASS");
    await clickWorkspace(mainWindow.webContents, "D5 Account A Secondary");
    recordMarker("WORKSPACE_SWITCH_SELECTED=PASS");
    await click(mainWindow.webContents, "button[role=tab]:nth-child(1)");
    recordMarker("WORKSPACE_SWITCH_FILE_TAB=PASS");
    await waitForRenderer(
      mainWindow.webContents,
      "[...document.querySelectorAll('button[role=treeitem]')].some(button=>button.textContent?.includes('secondary.txt'))",
      "second Workspace file tree",
    );
    recordMarker("WORKSPACE_SWITCH_FILE_TREE=PASS");
    await clickByText(mainWindow.webContents, "button[role=treeitem]", "secondary.txt");
    recordMarker("WORKSPACE_SWITCH_FILE_SELECTED=PASS");
    await waitForRenderer(
      mainWindow.webContents,
      "document.body.innerText.includes('D5_SECONDARY_WORKSPACE')",
      "Workspace switch updates the file panel",
    );
    recordMarker("WORKSPACE_SWITCH_PREVIEW=PASS");
    await waitFor(
      () => !terminalManager.sessions.has(terminalIdA),
      "old USER_TERMINAL closed on Workspace switch",
      10_000,
    );
    recordMarker("WORKSPACE_SWITCH_TERMINAL_SESSION_REVOKED=PASS");
    const powershellAfterSwitch = new Set(readPowerShellProcessIds());
    for (const processId of terminalPowerShellIds)
      assert.equal(powershellAfterSwitch.has(processId), false);
    recordMarker("WORKSPACE_SWITCH_POWERSHELL_EXITED=PASS");
    await waitFor(
      () => !isProcessRunning(terminalHelperPidA!),
      "USER_TERMINAL helper exited after Workspace switch",
    );
    recordMarker("WORKSPACE_SWITCH_HELPER_EXITED=PASS");
    const staleTerminalResult = await rendererCall(
      mainWindow.webContents,
      `(async()=>{try{await window.caelushDesktop.workspace.terminal.write({terminalId:${JSON.stringify(terminalIdA)},data:${JSON.stringify("echo stale\r")}});return 'unexpected'}catch(error){return error.message}})()`,
    );
    assert.equal(staleTerminalResult, "The user terminal session is unavailable.");
    recordMarker("WORKSPACE_SWITCH_STALE_TERMINAL_REJECTED=PASS");
    await click(mainWindow.webContents, "button[role=tab]:nth-child(2)");
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('.desktop-terminal') !== null",
      "second Workspace user terminal panel",
    );
    const beforeManualTerminal = new Set(readPowerShellProcessIds());
    await clickByText(mainWindow.webContents, ".desktop-terminal button", "打开 PowerShell");
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('.desktop-terminal')?.innerText.includes('关闭终端') === true",
      "second USER_TERMINAL",
    );
    const secondTerminal = [...terminalManager.sessions.entries()][0];
    assert.ok(secondTerminal !== undefined);
    const [secondTerminalId, secondTerminalRecord] = secondTerminal;
    const secondTerminalHelperPid = secondTerminalRecord.child.pid;
    assert.ok(Number.isInteger(secondTerminalHelperPid) && secondTerminalHelperPid! > 0);
    const secondTerminalPowerShellIds = difference(
      new Set(readPowerShellProcessIds()),
      beforeManualTerminal,
    );
    assert.ok(secondTerminalPowerShellIds.length > 0);
    await clickByText(mainWindow.webContents, ".desktop-terminal button", "关闭终端");
    await waitFor(() => terminalManager.sessions.size === 0, "explicit terminal close");
    await waitFor(
      () => !isProcessRunning(secondTerminalHelperPid!),
      "USER_TERMINAL helper exited after explicit close",
    );
    const afterManualTerminal = new Set(readPowerShellProcessIds());
    for (const processId of secondTerminalPowerShellIds)
      assert.equal(afterManualTerminal.has(processId), false);
    assert.match(secondTerminalId, /^[A-Za-z0-9_-]{43}$/u);
    recordMarker("WORKSPACE_SWITCH_AND_TERMINAL_PROCESS_CLEANUP=PASS");

    setFailureStage("WINDOW_RESIZE_PANEL_LAYOUT");
    await mainWindow.setSize(980, 700);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const layoutAfterResize = await execute(
      mainWindow.webContents,
      `(()=>{const input=document.querySelector('textarea[aria-label="任务输入"]');const panel=document.querySelector('.desktop-workspace-panel');return {composerWidth:input?.getBoundingClientRect().width??0,panelWidth:panel?.getBoundingClientRect().width??0}})()`,
    );
    assert.ok(layoutAfterResize.composerWidth >= 140);
    assert.ok(layoutAfterResize.panelWidth >= 280);
    recordMarker("WINDOW_RESIZE_COMPOSER_AND_PANEL=PASS");
    await mainWindow.setSize(1120, 760);
    await new Promise((resolve) => setTimeout(resolve, 300));

    setFailureStage("PROFILE_SWITCH_AND_BROWSER_ISOLATION");
    await panels.closeAll();
    const currentBrowserGuest = (
      panels as unknown as {
        browser: {
          guest?: { readonly leaseId: string; readonly view: { webContents: WebContents } };
        };
      }
    ).browser.guest;
    recordMarker(
      `PROFILE_BROWSER_DESTROY_STATE=${JSON.stringify({ retainedDestroyed: guestA.isDestroyed(), managerHasGuest: currentBrowserGuest !== undefined, managerDestroyed: currentBrowserGuest?.view.webContents.isDestroyed() ?? null })}`,
    );
    await waitFor(
      () => guestA.isDestroyed(),
      "Browser Guest destruction on Profile boundary",
      3000,
    );
    assert.equal(guestA.isDestroyed(), true);
    await supervisor.beginAccountBoundary();
    await account.logout(new AbortController().signal);
    assert.equal(supervisor.getActiveProfileIdentity(), null);
    await account.login(
      { email: emailB, password: "fixture-password-only" },
      new AbortController().signal,
    );
    assert.equal(account.getState().status, "AUTHENTICATED_ONLINE");
    await supervisor.synchronizeAccountState(account.getState());
    assert.equal(supervisor.getActiveProfileIdentity()?.userId, userB);
    const profileB = await profileManager.selectForUser(userB);
    assert.notEqual(profileB.profileId, profileIdForUser(userA));
    assert.notEqual(profileB.browserDirectory, workspaceAProfile.browserDirectory);
    const staleWorkspaceResult = await rendererCall(
      mainWindow.webContents,
      `(async()=>{try{await window.caelushDesktop.workspace.activate({workspaceId:${JSON.stringify(workspaceA.id)}});return 'unexpected'}catch(error){return error.message}})()`,
    );
    assert.equal(staleWorkspaceResult, "This Workspace is not registered in the active Profile.");
    const revokedFileResult = await rendererCall(
      mainWindow.webContents,
      `(async()=>{try{await window.caelushDesktop.workspace.previewText({workspaceId:${JSON.stringify(workspaceA.id)},relativePath:'src/hello.ts'});return 'unexpected'}catch(error){return error.message}})()`,
    );
    assert.notEqual(revokedFileResult, "unexpected");
    const revokedBrowserResult = await rendererCall(
      mainWindow.webContents,
      `(async()=>{try{await window.caelushDesktop.browser.navigate({leaseId:${JSON.stringify(browserLeaseA)},url:'https://example.com/'});return 'unexpected'}catch(error){return error.message}})()`,
    );
    assert.notEqual(revokedBrowserResult, "unexpected");

    await createWorkspace(proxy, workspaceBPath, "D5 Account B Workspace");
    await mainWindow.loadURL("caelush-app://app/agent/");
    await waitForRenderer(
      mainWindow.webContents,
      "document.querySelector('[aria-label=\"展开桌面面板\"]') !== null",
      "Agent UI after Account switch",
    );
    await click(mainWindow.webContents, 'button[aria-label="展开桌面面板"]');
    await waitForRenderer(
      mainWindow.webContents,
      "document.body.innerText.includes('account-b.txt')",
      "Account B file tree",
    );
    await clickByText(mainWindow.webContents, "button[role=tab]", "浏览器");
    const accountBBrowserViewport = await execute(
      mainWindow.webContents,
      "(()=>{const element=document.querySelector('.desktop-browser-viewport');const rect=element?.getBoundingClientRect();return rect===undefined?null:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,hidden:element.closest('[hidden]')!==null}})()",
    );
    recordMarker(`ACCOUNT_B_BROWSER_VIEWPORT=${JSON.stringify(accountBBrowserViewport)}`);
    const browserLeaseB = await ensureBrowserGuestLease(mainWindow.webContents);
    await setInputValue(
      mainWindow.webContents,
      'input[aria-label="浏览器网址"]',
      "https://example.com/",
    );
    await click(mainWindow.webContents, 'button[aria-label="导航"]');
    const guestB = await waitForGuest("https://example.com/");
    assert.equal(await execute(guestB, "document.cookie.includes('d5_profile=account_a')"), false);
    assert.equal(
      await execute(guestB, "typeof window.process + ':' + typeof window.caelushDesktop"),
      "undefined:undefined",
    );
    await panels.closeAll();
    await waitFor(() => guestB.isDestroyed(), "Browser Guest destroyed at authorization boundary");
    const staleGenerationAvailability = await rendererCall(
      mainWindow.webContents,
      "window.caelushDesktop.workspace.getAvailability()",
    );
    assert.deepEqual(staleGenerationAvailability, { available: true });
    const countsAfterDesktopActions = readRunCounts(workspaceAProfile.databasePath);
    assert.deepEqual(countsAfterDesktopActions, runCountsBeforeTerminal);
    recordMarker("ACCOUNT_PROFILE_GENERATION_REVOKE_AND_BROWSER_COOKIE_ISOLATION=PASS");

    recordMarker("DAEMON_GRACEFUL_SHUTDOWN=PASS");
    recordMarker("D5_WINDOWS_ELECTRON_SMOKE=PASS");
  } catch (error) {
    recordMarker(`D5_FAILURE_STAGE=${failureStage}`);
    const errorDetail =
      error instanceof Error
        ? `${error.message} ${error.stack?.split("\n").slice(1, 5).join(" | ") ?? ""}`
        : "unknown";
    recordMarker(`D5_FAILURE=${errorDetail.replace(/[\r\n]+/gu, " ").slice(0, 1600)}`);
    process.exitCode = 1;
  } finally {
    await appendFile(markerPath, `${markerLines.join("\n")}\n`, "utf8").catch(() => undefined);
    disposeIpc?.();
    await panels?.closeAll().catch(() => undefined);
    panels?.dispose();
    await supervisor?.closeForApplicationQuit().catch(() => undefined);
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.destroy();
    if (fixture !== undefined) await closeServer(fixture);
    await rm(workspaceAPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceA2Path, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceBPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(outsidePath, { recursive: true, force: true }).catch(() => undefined);
    app.quit();
  }
});

async function seedOfflineAccount(
  selectedVault: DpapiVault,
  input: {
    readonly email: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly signingKey: KeyObject;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const identity = generateDeviceIdentity();
  const offlineGrant = createSignedGrant(input.signingKey, input.userId, input.deviceId);
  const record: StoredAccountRecord = {
    schemaVersion: 1,
    normalizedEmail: input.email,
    userId: input.userId,
    emailVerified: true,
    createdAt: now,
    deviceId: input.deviceId,
    deviceCreatedAt: now,
    deviceLastSeenAt: now,
    deviceLabel: "D5 isolated Windows fixture",
    devicePrivateKeyPkcs8Base64: identity.privateKeyPkcs8Base64,
    devicePublicKeyBase64Url: identity.publicKeyBase64Url,
    sessionId: null,
    refreshToken: null,
    rotationUncertain: false,
    offlineGrant,
    lastTrustedServerTime: now,
    lastAcceptedTime: now,
    entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
    accountEmail: input.email,
  };
  const key = accountVaultKey(input.email);
  await selectedVault.set(key, record);
  await writeActiveAccount(selectedVault, key);
}

function createFixtureCloud(signingKey: KeyObject): Record<string, unknown> {
  return {
    login: async (input: { readonly email: string }) => {
      const now = new Date();
      const userIdForLogin = userB;
      const deviceId = randomUUID();
      return {
        requestId: randomUUID(),
        sessionId: randomUUID(),
        account: {
          userId: userIdForLogin,
          email: input.email.trim().toLowerCase(),
          emailVerified: true,
          entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
          createdAt: now.toISOString(),
        },
        device: {
          deviceId,
          label: "D5 Cloud login fixture",
          createdAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
          revokedAt: null,
          current: true,
        },
        tokens: {
          tokenType: "Bearer",
          accessToken: Buffer.from(randomUUID()).toString("base64url").padEnd(43, "x"),
          accessExpiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
          refreshToken: Buffer.from(randomUUID()).toString("base64url").padEnd(43, "r"),
          refreshExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
          refreshAbsoluteExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60_000).toISOString(),
        },
        offlineGrant: createSignedGrant(signingKey, userIdForLogin, deviceId),
      };
    },
  };
}

function createSignedGrant(signingKey: KeyObject, userId: string, deviceId: string) {
  const issuedAt = new Date();
  const payload = {
    schemaVersion: 1,
    grantId: randomUUID(),
    userId,
    deviceId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
    entitlements: [{ code: "CAELUSH_DESKTOP_BASIC", enabled: true }],
    keyId: "d5_fixture_key",
  } as const;
  return {
    envelopeVersion: 1,
    payload,
    signature: sign(null, Buffer.from(canonicalizeJcs(payload), "utf8"), signingKey).toString(
      "base64url",
    ),
  };
}

async function createWorkspace(
  proxy: DesktopLocalProxy,
  root: string,
  displayName: string,
): Promise<{ readonly id: string; readonly canonicalPath: string }> {
  const created = await localApi(proxy, "/api/v1/workspaces", {
    method: "POST",
    body: { path: root, displayName },
  });
  return { id: String(created.value.id), canonicalPath: String(created.value.canonicalPath) };
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestChunks: Buffer[] = [];
  for await (const chunk of request)
    requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(requestChunks).toString("utf8");
  const pathname = request.url ?? "/";
  if (pathname === "/v1/models" && request.method === "GET") {
    if (request.headers.authorization !== `Bearer ${providerKey}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture authentication failed" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ data: [{ id: modelId, object: "model", owned_by: "d5-fixture" }] }),
    );
    return;
  }
  if (pathname === "/v1/chat/completions" && request.method === "POST") {
    if (request.headers.authorization !== `Bearer ${providerKey}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture authentication failed" } }));
      return;
    }
    chatCalls.push(body.slice(0, 4096));
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      `data: ${JSON.stringify({
        id: "caelush-d5-scripted-provider-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.end(
      `${chunk({ role: "assistant", content: "The local D5 Electron fixture run completed." })}${chunk({}, "stop")}data: [DONE]\n\n`,
    );
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "fixture route not found" } }));
}

async function localApi(
  proxy: DesktopLocalProxy,
  route: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Promise<{ readonly status: number; readonly value: any }> {
  const method = options.method ?? "GET";
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
  const body =
    serialized === undefined
      ? null
      : new Request("http://test.invalid/", { method, body: serialized }).body;
  const request = {
    url: `caelush-app://app${route}`,
    method,
    headers: new Headers(serialized === undefined ? {} : { "content-type": "application/json" }),
    body,
    signal: new AbortController().signal,
    referrer: "",
    initiatorOrigin: "caelush-app://app",
  } as Request;
  const response = await proxy.handle(request);
  const text = await response.text();
  let value: any = undefined;
  if (text.length > 0) value = JSON.parse(text);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`protected local request failed (${response.status})`);
  }
  return { status: response.status, value };
}

function provider(payload: any, id: string): any {
  const item =
    payload.providers?.find((entry: any) => entry.id === id) ??
    (payload.provider?.id === id ? payload.provider : undefined);
  assert.ok(item);
  return item;
}

async function waitForGuest(expectedUrl: string): Promise<WebContents> {
  await waitFor(
    () =>
      webContents
        .getAllWebContents()
        .some((contents) => contents.getURL() === expectedUrl && !contents.isLoading()),
    `Browser Guest ${expectedUrl}`,
    30_000,
  );
  const guest = webContents
    .getAllWebContents()
    .find((contents) => contents.getURL() === expectedUrl);
  assert.ok(guest);
  return guest;
}

function findBrowserViewBounds(window: BrowserWindow, contents: WebContents): Electron.Rectangle {
  const view = (
    window as unknown as {
      contentView: {
        children?: readonly { webContents?: WebContents; getBounds(): Electron.Rectangle }[];
      };
    }
  ).contentView.children?.find((child) => child.webContents === contents);
  assert.ok(view);
  return view.getBounds();
}

function terminalOutputFor(
  _controller: DesktopWorkspacePanelController | undefined,
  terminalId: string,
): string {
  return terminalOutputText.get(terminalId) ?? "";
}

function readPowerShellProcessIds(): number[] {
  const tasklist = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
  const output = execFileSync(
    tasklist,
    ["/FI", "IMAGENAME eq powershell.exe", "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  return [...output.matchAll(/"powershell\.exe","(\d+)"/giu)].map((match) => Number(match[1]));
}

function difference(left: ReadonlySet<number>, right: ReadonlySet<number>): number[] {
  return [...left].filter((value) => !right.has(value));
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function readRunCounts(databasePath: string): {
  readonly runs: number;
  readonly invocations: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      runs: Number(
        (database.prepare("SELECT count(*) AS count FROM agent_runs").get() as { count: number })
          .count,
      ),
      invocations: Number(
        (
          database.prepare("SELECT count(*) AS count FROM tool_invocations").get() as {
            count: number;
          }
        ).count,
      ),
    };
  } finally {
    database.close();
  }
}

async function setTextArea(contents: WebContents, text: string): Promise<void> {
  await execute(
    contents,
    `(()=>{const element=document.querySelector('textarea[aria-label="任务输入"]');if(!element)throw new Error('composer missing');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;setter?.call(element,${JSON.stringify(text)});element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(text)}}));element.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
  );
}

async function setInputValue(
  contents: WebContents,
  selector: string,
  value: string,
): Promise<void> {
  const updated = await execute(
    contents,
    `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!(element instanceof HTMLInputElement))return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;setter?.call(element,${JSON.stringify(value)});element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(value)}}));element.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
  );
  assert.equal(updated, true, `UI input not found: ${selector}`);
}

async function ensureBrowserGuestLease(contents: WebContents): Promise<string> {
  await waitForRenderer(
    contents,
    "(()=>{const rect=document.querySelector('.desktop-browser-viewport')?.getBoundingClientRect();return rect!==undefined&&rect.width>=140&&rect.height>=120})()",
    "visible Browser Guest viewport",
  );
  const bounds = await execute(
    contents,
    "(()=>{const rect=document.querySelector('.desktop-browser-viewport').getBoundingClientRect();return {x:Math.round(rect.left),y:Math.round(rect.top),width:Math.round(rect.width),height:Math.round(rect.height)}})()",
  );
  const state = await rendererCall(
    contents,
    `window.caelushDesktop.browser.createLease({bounds:${JSON.stringify(bounds)}})`,
  );
  const needsUiLease = await execute(
    contents,
    "document.querySelector('.desktop-browser .desktop-small-button')?.textContent?.includes('打开浏览器 Guest')===true",
  );
  if (needsUiLease) {
    await clickByText(contents, ".desktop-browser .desktop-small-button", "打开浏览器 Guest");
  }
  await waitForRenderer(
    contents,
    "document.querySelector('input[aria-label=\"浏览器网址\"]') !== null",
    "Browser Guest address controls",
  );
  return String(state.leaseId);
}

async function clickWorkspace(contents: WebContents, displayName: string): Promise<void> {
  await execute(
    contents,
    `(()=>{const button=[...document.querySelectorAll('.workspace-list-button')].find(item=>item.textContent?.includes(${JSON.stringify(displayName)}));if(!button)throw new Error('Workspace button missing');button.click();return true})()`,
  );
}

async function clickByText(contents: WebContents, selector: string, text: string): Promise<void> {
  const clicked = await execute(
    contents,
    `(()=>{const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>item.textContent?.includes(${JSON.stringify(text)}));if(!button)return false;button.click();return true})()`,
  );
  assert.equal(clicked, true, `UI control not found: ${text}`);
}

async function click(contents: WebContents, selector: string): Promise<void> {
  const clicked = await execute(
    contents,
    `(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button)return false;button.click();return true})()`,
  );
  assert.equal(clicked, true, `UI control not found: ${selector}`);
}

async function rendererCall(contents: WebContents, expression: string): Promise<any> {
  return execute(contents, `(${expression})`);
}

async function execute(contents: WebContents, source: string): Promise<any> {
  return contents.executeJavaScript(source, true);
}

async function waitForRenderer(
  contents: WebContents,
  expression: string,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  try {
    await waitFor(
      async () => Boolean(await execute(contents, expression).catch(() => false)),
      label,
      timeoutMs,
    );
  } catch (error) {
    const details = await execute(
      contents,
      "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,selectedWorkspace:document.querySelector('.workspace-list-item--selected .workspace-list-copy strong')?.textContent,panelError:document.querySelector('.desktop-panel-error')?.textContent,panel:document.querySelector('.desktop-panel-body')?.innerText,body:document.body?.innerText?.slice(0,400)})",
    ).catch(() => "renderer-unavailable");
    throw new Error(
      `${error instanceof Error ? error.message : "Renderer wait failed."} ${String(details)}`,
    );
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch {
      // The Renderer can be between a route transition and its next commit.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function isAgentWindow(window: BrowserWindow | undefined): boolean {
  if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed())
    return false;
  try {
    return new URL(window.webContents.mainFrame.url).pathname === "/agent/";
  } catch {
    return false;
  }
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error("smoke configuration missing");
  return value;
}

function setFailureStage(stage: string): void {
  failureStage = stage;
  process.stdout.write(`D5_STAGE=${stage}\n`);
}

function recordMarker(marker: string): void {
  markerLines.push(marker);
  process.stdout.write(`${marker}\n`);
}
