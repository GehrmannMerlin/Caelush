import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { ArrowLeft, ArrowRight, ExternalLink, LoaderCircle, RotateCw, X } from "lucide-react";
import type { DesktopBrowserState, DesktopPanelApi } from "../host/desktop-panel-api.js";

export function DesktopBrowserControls(props: {
  readonly api: DesktopPanelApi;
  readonly visible: boolean;
}): ReactElement {
  const [state, setState] = useState<DesktopBrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  const creatingRef = useRef(false);
  stateRef.current = state;

  const syncBounds = useCallback(async () => {
    const current = stateRef.current;
    if (current === null) return;
    const element = viewportRef.current;
    if (!props.visible || element === null || !element.isConnected) {
      await props.api.browser
        .setBounds({ leaseId: current.leaseId, bounds: null })
        .catch(() => undefined);
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    try {
      await props.api.browser.setBounds({
        leaseId: current.leaseId,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    } catch (boundsError) {
      setError(messageOf(boundsError, "浏览器面板尺寸无效。"));
    }
  }, [props.api, props.visible]);
  const syncBoundsRef = useRef(syncBounds);
  syncBoundsRef.current = syncBounds;

  const createGuest = useCallback(async () => {
    const element = viewportRef.current;
    if (!props.visible || element === null || stateRef.current !== null || creatingRef.current)
      return;
    const rect = element.getBoundingClientRect();
    if (rect.width < 140 || rect.height < 120) return;
    creatingRef.current = true;
    setError(null);
    try {
      const next = await props.api.browser.createLease({
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
      stateRef.current = next;
      setState(next);
    } catch (createError) {
      setError(messageOf(createError, "内置浏览器无法启动。"));
    } finally {
      creatingRef.current = false;
    }
  }, [props.api, props.visible]);
  const createGuestRef = useRef(createGuest);
  createGuestRef.current = createGuest;

  useEffect(() => {
    const unsubscribe = props.api.browser.subscribeState((next) => {
      if (stateRef.current === null || stateRef.current.leaseId === next.leaseId) {
        stateRef.current = next;
        setState(next);
        if (next.url !== "") setAddress(next.url);
        if (next.errorCode !== undefined)
          setError(
            next.errorCode === "BROWSER_GUEST_CRASHED"
              ? "浏览器页面意外关闭。"
              : "网站无法载入。请检查 URL 后重试。",
          );
      }
    });
    const observer = new ResizeObserver(() => {
      void syncBoundsRef.current();
      if (stateRef.current === null) void createGuestRef.current();
    });
    if (viewportRef.current !== null) observer.observe(viewportRef.current);
    const onResize = () => void syncBoundsRef.current();
    window.addEventListener("resize", onResize);
    return () => {
      unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      const current = stateRef.current;
      if (current !== null)
        void props.api.browser.closeLease({ leaseId: current.leaseId }).catch(() => undefined);
    };
  }, [props.api]);

  useEffect(() => {
    void createGuest();
  }, [createGuest]);

  useEffect(() => {
    if (state !== null) void syncBounds();
  }, [state?.leaseId, props.visible, syncBounds]);

  const navigate = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (stateRef.current === null) {
        setError("浏览器正在准备中，请稍候。 ");
        return;
      }
      const raw = address.trim();
      const url = /^[a-z][a-z0-9+.-]*:/iu.test(raw) ? raw : `https://${raw}`;
      setError(null);
      try {
        const next = await props.api.browser.navigate({ leaseId: stateRef.current.leaseId, url });
        stateRef.current = next;
        setState(next);
        if (next.url !== "") setAddress(next.url);
      } catch (navigateError) {
        setError(messageOf(navigateError, "仅支持可公开访问的 HTTPS 网站。"));
      }
    },
    [address, props.api],
  );

  const navigateAction = useCallback(
    async (action: "back" | "forward" | "reload") => {
      const current = stateRef.current;
      if (current === null) return;
      setError(null);
      try {
        const next =
          action === "back"
            ? await props.api.browser.goBack({ leaseId: current.leaseId })
            : action === "forward"
              ? await props.api.browser.goForward({ leaseId: current.leaseId })
              : await props.api.browser.reload({ leaseId: current.leaseId });
        stateRef.current = next;
        setState(next);
      } catch (actionError) {
        setError(messageOf(actionError, "浏览器操作失败。"));
      }
    },
    [props.api],
  );

  const close = useCallback(async () => {
    const current = stateRef.current;
    stateRef.current = null;
    setState(null);
    setAddress("");
    setError(null);
    if (current !== null)
      await props.api.browser.closeLease({ leaseId: current.leaseId }).catch(() => undefined);
  }, [props.api]);

  return createElement(
    "section",
    { className: "desktop-browser", "aria-label": "内置浏览器" },
    createElement(
      "form",
      { className: "desktop-browser-toolbar", onSubmit: navigate },
      createElement(
        "button",
        {
          type: "button",
          className: "desktop-icon-button",
          onClick: () => void navigateAction("back"),
          title: "后退",
          "aria-label": "后退",
        },
        createElement(ArrowLeft, { size: 15 }),
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "desktop-icon-button",
          onClick: () => void navigateAction("forward"),
          title: "前进",
          "aria-label": "前进",
        },
        createElement(ArrowRight, { size: 15 }),
      ),
      createElement(
        "div",
        { className: "desktop-browser-address" },
        state?.loading
          ? createElement(LoaderCircle, {
              size: 14,
              className: "desktop-browser-spinner",
              "aria-label": "正在载入",
            })
          : null,
        createElement("input", {
          type: "url",
          value: address,
          onChange: (event) => setAddress(event.currentTarget.value),
          placeholder: "https://example.com",
          "aria-label": "浏览器网址",
        }),
      ),
      createElement(
        "button",
        { type: "submit", className: "desktop-icon-button", title: "导航", "aria-label": "导航" },
        createElement(ExternalLink, { size: 14 }),
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "desktop-icon-button",
          onClick: () => void navigateAction("reload"),
          title: "刷新",
          "aria-label": "刷新",
        },
        createElement(RotateCw, { size: 14 }),
      ),
      createElement(
        "button",
        {
          type: "button",
          className: "desktop-icon-button",
          onClick: () => void close(),
          title: "关闭浏览器",
          "aria-label": "关闭浏览器",
        },
        createElement(X, { size: 14 }),
      ),
    ),
    error === null
      ? null
      : createElement("p", { className: "desktop-panel-error", role: "alert" }, error),
    createElement(
      "div",
      {
        ref: viewportRef,
        className: "desktop-browser-viewport",
        role: "region",
        "aria-label": "浏览器网页内容",
      },
      state === null
        ? createElement(
            "div",
            { className: "desktop-browser-empty" },
            createElement(
              "p",
              { className: "desktop-panel-hint" },
              "输入公开 HTTPS 网址开始浏览。",
            ),
            createElement(
              "button",
              {
                type: "button",
                className: "desktop-small-button",
                onClick: () => void createGuest(),
                disabled: !props.visible,
              },
              "打开浏览器 Guest",
            ),
          )
        : null,
    ),
  );
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 240)
    : fallback;
}
