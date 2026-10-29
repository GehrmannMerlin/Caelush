import { BrowserWindow } from "electron";

/** Built-in status text is safe to display before installed resources are verified. */
export function createStartupWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "Caelush 正在启动",
    width: 440,
    height: 220,
    show: true,
    center: true,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>body{margin:36px;font:15px/1.7 system-ui;color:#192746}h1{font-size:22px;margin:0 0 12px}p{margin:0;color:#58677d}</style>
    <h1>Caelush 正在启动</h1><p>正在校验应用文件，请稍候…</p><p>首次启动可能需要更长时间。</p></html>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {
    // The native title remains visible if Chromium cannot render the status page.
  });
  return window;
}
