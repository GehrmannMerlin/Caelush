import { createElement, useState, type FormEvent, type ReactElement } from "react";
import { ArrowLeft, KeyRound, LoaderCircle, Sparkles, X } from "lucide-react";
import type { ModelView, ProviderView } from "@caelush/protocol";
import anthropicIcon from "../assets/providers/anthropic.svg";
import deepseekIcon from "../assets/providers/deepseek.svg";
import geminiIcon from "../assets/providers/gemini.svg";
import glmIcon from "../assets/providers/glm.svg";
import groqIcon from "../assets/providers/groq.svg";
import kimiIcon from "../assets/providers/kimi.svg";
import minimaxIcon from "../assets/providers/minimax.svg";
import mimoIcon from "../assets/providers/mimo.svg";
import mistralIcon from "../assets/providers/mistral.svg";
import openaiIcon from "../assets/providers/openai.svg";
import openrouterIcon from "../assets/providers/openrouter.svg";
import qwenIcon from "../assets/providers/qwen.svg";

const PROVIDER_BRAND_ICONS: Readonly<Record<string, string>> = {
  openai: openaiIcon,
  deepseek: deepseekIcon,
  openrouter: openrouterIcon,
  anthropic: anthropicIcon,
  kimi: kimiIcon,
  glm: glmIcon,
  minimax: minimaxIcon,
  mimo: mimoIcon,
  qwen: qwenIcon,
  gemini: geminiIcon,
  groq: groqIcon,
  mistral: mistralIcon,
};

export interface SettingsSurfaceProps {
  readonly providers: readonly ProviderView[];
  readonly models: readonly ModelView[];
  readonly onClose: () => void;
  readonly onConnect: (providerId: string, apiKey: string) => Promise<boolean>;
  readonly onDisconnect: (providerId: string) => Promise<boolean>;
}

export function SettingsSurface(props: SettingsSurfaceProps): ReactElement {
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>();
  const selected = props.providers.find((provider) => provider.id === selectedProviderId);
  return createElement(
    "div",
    { className: "settings-surface", role: "dialog", "aria-modal": true, "aria-label": "设置" },
    createElement(
      "div",
      { className: "settings-surface-panel" },
      createElement(
        "div",
        { className: "settings-surface-header" },
        createElement(
          "div",
          null,
          createElement("span", { className: "settings-eyebrow" }, "WORKSPACE SETTINGS"),
          createElement("h2", null, "模型与 API"),
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "settings-close-button",
            onClick: props.onClose,
            "aria-label": "关闭设置",
          },
          createElement(X, { size: 18, "aria-hidden": true }),
        ),
      ),
      selected === undefined
        ? createElement(
            "div",
            { className: "settings-provider-list" },
            createElement(
              "p",
              { className: "settings-intro" },
              "连接 Provider 后即可发现可用模型。",
            ),
            props.providers.map((provider) =>
              createElement(
                "button",
                {
                  type: "button",
                  className: "settings-provider-card",
                  key: provider.id,
                  onClick: () => setSelectedProviderId(provider.id),
                },
                createElement(
                  "span",
                  { className: "settings-provider-copy" },
                  createElement(
                    "span",
                    { className: "settings-provider-name" },
                    createProviderBrandIcon(provider.id),
                    createElement("strong", null, provider.displayName),
                  ),
                  createElement("small", null, provider.id),
                ),
                createElement(
                  "span",
                  {
                    className: `settings-provider-status settings-provider-status--${provider.credentialConfigured ? "connected" : "disconnected"}`,
                  },
                  provider.credentialSource === "ENVIRONMENT"
                    ? "由环境变量提供"
                    : provider.credentialConfigured
                      ? "已连接"
                      : "未连接",
                ),
              ),
            ),
          )
        : createElement(ProviderEditor, {
            provider: selected,
            modelCount: props.models.filter((model) => model.provider === selected.id).length,
            onBack: () => setSelectedProviderId(undefined),
            onConnect: props.onConnect,
            onDisconnect: props.onDisconnect,
          }),
    ),
  );
}

function ProviderEditor(props: {
  readonly provider: ProviderView;
  readonly modelCount: number;
  readonly onBack: () => void;
  readonly onConnect: (providerId: string, apiKey: string) => Promise<boolean>;
  readonly onDisconnect: (providerId: string) => Promise<boolean>;
}): ReactElement {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const environmentOwned = props.provider.credentialSource === "ENVIRONMENT";
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (environmentOwned || apiKey.trim().length === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    const ok = await props.onConnect(props.provider.id, apiKey);
    setBusy(false);
    if (!ok) setError("API Key 无效或 Provider 暂时不可连接。");
    else setApiKey("");
  };
  const disconnect = async () => {
    if (environmentOwned || busy) return;
    setBusy(true);
    setError(undefined);
    const ok = await props.onDisconnect(props.provider.id);
    setBusy(false);
    if (!ok) setError("Provider 断开失败，请稍后重试。");
  };
  return createElement(
    "div",
    { className: "settings-provider-editor" },
    createElement(
      "button",
      { type: "button", className: "settings-back-button", onClick: props.onBack },
      createElement(ArrowLeft, { size: 15, "aria-hidden": true }),
      "全部 Provider",
    ),
    createElement(
      "div",
      { className: "settings-provider-editor-title" },
      createProviderBrandIcon(props.provider.id),
      createElement("h3", null, props.provider.displayName),
    ),
    createElement(
      "p",
      { className: "settings-provider-state" },
      createElement("span", {
        className: `status-dot${props.provider.credentialConfigured ? " status-dot--on" : ""}`,
      }),
      props.provider.credentialSource === "ENVIRONMENT"
        ? "由环境变量提供 · 只读"
        : props.provider.credentialConfigured
          ? "已连接"
          : "未连接",
    ),
    props.provider.discoveryError === undefined
      ? null
      : createElement("p", { className: "settings-inline-error" }, props.provider.discoveryError),
    createElement("p", { className: "settings-model-count" }, `${props.modelCount} 个可用模型`),
    environmentOwned
      ? createElement(
          "p",
          { className: "settings-readonly-note" },
          "此 Key 由 daemon 环境变量提供，不能在网页中覆盖或删除。",
        )
      : createElement(
          "form",
          { className: "settings-key-form", onSubmit: submit },
          createElement(
            "label",
            { className: "settings-key-label" },
            "API Key",
            createElement(
              "div",
              { className: "settings-key-input-wrap" },
              createElement(KeyRound, { size: 15, "aria-hidden": true }),
              createElement("input", {
                type: "password",
                value: apiKey,
                onChange: (event) => setApiKey(event.currentTarget.value),
                placeholder: props.provider.credentialConfigured
                  ? "已配置。输入新的 API Key 可替换"
                  : "输入 API Key",
                autoComplete: "new-password",
                disabled: busy,
              }),
            ),
          ),
          createElement(
            "div",
            { className: "settings-editor-actions" },
            createElement(
              "button",
              {
                type: "submit",
                className: "settings-primary-button",
                disabled: busy || apiKey.trim().length === 0,
              },
              busy
                ? createElement(LoaderCircle, { size: 15, className: "prompt-submit-spinner" })
                : null,
              props.provider.credentialConfigured ? "替换" : "连接",
            ),
            props.provider.credentialConfigured
              ? createElement(
                  "button",
                  {
                    type: "button",
                    className: "settings-danger-button",
                    onClick: () => void disconnect(),
                    disabled: busy,
                  },
                  "断开",
                )
              : null,
          ),
          error === undefined
            ? null
            : createElement("p", { className: "settings-inline-error" }, error),
        ),
  );
}

function createProviderBrandIcon(providerId: string): ReactElement {
  const icon = PROVIDER_BRAND_ICONS[providerId];
  return icon === undefined
    ? createElement(Sparkles, {
        className: "settings-provider-icon settings-provider-icon--fallback",
        size: 22,
        "aria-hidden": true,
      })
    : createElement("img", {
        className: "settings-provider-icon",
        src: icon,
        alt: "",
        "aria-hidden": true,
      });
}
