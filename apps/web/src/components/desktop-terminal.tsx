import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { DesktopPanelApi, DesktopTerminalSession } from "../host/desktop-panel-api.js";

export function DesktopTerminal(props: {
  readonly api: DesktopPanelApi;
  readonly workspaceId: string | null;
  readonly visible: boolean;
}): ReactElement {
  const [session, setSession] = useState<DesktopTerminalSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<DesktopTerminalSession | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    const host = containerRef.current;
    if (host === null) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 12,
      scrollback: 1500,
      theme: {
        background: "#101615",
        foreground: "#dce7df",
        cursor: "#b5e3a4",
        selectionBackground: "#3e5a52",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.parser.registerOscHandler(52, () => true);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const sendResize = () => {
      if (sessionRef.current !== null) {
        void props.api.workspace.terminal
          .resize({
            terminalId: sessionRef.current.terminalId,
            cols: terminal.cols,
            rows: terminal.rows,
          })
          .catch((resizeError: unknown) => setError(messageOf(resizeError, "终端尺寸更新失败。")));
      }
    };
    const resizeDisposable = terminal.onResize(sendResize);
    const inputDisposable = terminal.onData((data) => {
      const current = sessionRef.current;
      if (current !== null)
        void props.api.workspace.terminal
          .write({ terminalId: current.terminalId, data })
          .catch((writeError: unknown) => setError(messageOf(writeError, "终端输入失败。")));
    });
    const observer = new ResizeObserver(() => {
      if (!props.visible) return;
      try {
        fit.fit();
        sendResize();
      } catch {
        // Hidden tabs can report a zero-sized host while the right panel is being resized.
      }
    });
    observer.observe(host);
    const firstFit = window.setTimeout(() => {
      if (!props.visible) return;
      try {
        fit.fit();
      } catch {
        /* The panel may still be collapsed. */
      }
    }, 0);
    return () => {
      window.clearTimeout(firstFit);
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      void closeCurrentSession(props.api, sessionRef.current, unsubscribeRef.current);
      unsubscribeRef.current = null;
      sessionRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, [props.api]);

  useEffect(() => {
    if (props.workspaceId === null) {
      void closeSession();
      return;
    }
    if (session !== null && session.workspaceId !== props.workspaceId) void closeSession();
  }, [props.workspaceId, session]);

  useEffect(() => {
    if (props.visible && terminalRef.current !== null) {
      const fit = fitRef.current;
      if (fit !== null) {
        window.requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            /* The terminal may be waiting for the panel to expand. */
          }
        });
      }
    }
  }, [props.visible]);

  const closeSession = useCallback(async () => {
    const current = sessionRef.current;
    const unsubscribe = unsubscribeRef.current;
    unsubscribeRef.current = null;
    sessionRef.current = null;
    setSession(null);
    if (unsubscribe !== null) unsubscribe();
    if (current !== null) {
      await props.api.workspace.terminal
        .close({ terminalId: current.terminalId })
        .catch(() => undefined);
    }
  }, [props.api]);

  const startSession = useCallback(async () => {
    if (props.workspaceId === null || sessionRef.current !== null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fit = fitRef.current;
      if (fit !== null) fit.fit();
      const terminal = terminalRef.current;
      const created = await props.api.workspace.terminal.create({
        workspaceId: props.workspaceId,
        cols: terminal?.cols ?? 80,
        rows: terminal?.rows ?? 24,
      });
      if (created.workspaceId !== props.workspaceId) {
        await props.api.workspace.terminal
          .close({ terminalId: created.terminalId })
          .catch(() => undefined);
        throw new Error("工作区已切换，请重试。 ");
      }
      sessionRef.current = created;
      setSession(created);
      const unsubscribe = await props.api.workspace.terminal.subscribeOutput(
        created.terminalId,
        (output) => {
          if (output.terminalId !== sessionRef.current?.terminalId) return;
          if (output.data !== undefined) {
            const bytes = new TextEncoder().encode(output.data).byteLength;
            terminalRef.current?.write(output.data, () => {
              void props.api.workspace.terminal
                .acknowledgeOutput({ terminalId: created.terminalId, bytes })
                .catch(() => undefined);
            });
          }
          if (output.exitCode !== undefined) {
            terminalRef.current?.write(
              `\r\n[PowerShell exited: ${output.exitCode ?? output.signal ?? "unknown"}]\r\n`,
            );
            sessionRef.current = null;
            setSession(null);
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
          }
          if (output.errorCode !== undefined) {
            setError(
              output.errorCode === "TERMINAL_OUTPUT_BACKPRESSURE"
                ? "输出过多，终端已关闭。"
                : "终端进程已停止。 ",
            );
            sessionRef.current = null;
            setSession(null);
          }
        },
      );
      if (sessionRef.current?.terminalId === created.terminalId)
        unsubscribeRef.current = unsubscribe;
      else unsubscribe();
      terminalRef.current?.focus();
      setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* The parent can still be sizing. */
        }
      }, 0);
    } catch (startError) {
      setError(messageOf(startError, "PowerShell 无法启动。"));
    } finally {
      setBusy(false);
    }
  }, [busy, props.api, props.workspaceId]);

  return createElement(
    "section",
    { className: "desktop-terminal", "aria-label": "用户 PowerShell 终端" },
    createElement(
      "div",
      { className: "desktop-terminal-toolbar" },
      createElement(
        "span",
        { className: "desktop-terminal-cwd", title: session?.cwd ?? "" },
        session?.cwd ?? "PowerShell",
      ),
      session === null
        ? createElement(
            "button",
            {
              type: "button",
              className: "desktop-small-button",
              disabled: busy || props.workspaceId === null,
              onClick: () => void startSession(),
            },
            busy ? "正在启动…" : "打开 PowerShell",
          )
        : createElement(
            "button",
            {
              type: "button",
              className: "desktop-small-button",
              onClick: () => void closeSession(),
            },
            "关闭终端",
          ),
    ),
    createElement(
      "p",
      { className: "desktop-terminal-warning", role: "note" },
      "用户终端以当前 Windows 用户权限执行命令，不受 Agent Tool 审批流程或 Agent Sandbox 约束。",
    ),
    error === null
      ? null
      : createElement("p", { className: "desktop-panel-error", role: "alert" }, error),
    props.workspaceId === null
      ? createElement(
          "div",
          { className: "desktop-panel-empty" },
          createElement("strong", null, "未选择工作区"),
          createElement("span", null, "选择工作区后即可启动用户终端。"),
        )
      : createElement("div", {
          ref: containerRef,
          className: "desktop-terminal-screen",
          "aria-label": "PowerShell 终端输出",
        }),
  );
}

async function closeCurrentSession(
  api: DesktopPanelApi,
  session: DesktopTerminalSession | null,
  unsubscribe: (() => void) | null,
): Promise<void> {
  unsubscribe?.();
  if (session !== null)
    await api.workspace.terminal.close({ terminalId: session.terminalId }).catch(() => undefined);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 240)
    : fallback;
}
