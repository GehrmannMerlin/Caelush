import { createElement, useState, type ReactElement } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Settings2 } from "lucide-react";
import type { ClientModelSelectionWithReasoning, ModelView, ProviderView } from "@caelush/protocol";

export interface ModelPickerProps {
  readonly providers: readonly ProviderView[];
  readonly models: readonly ModelView[];
  readonly selection?: ClientModelSelectionWithReasoning | undefined;
  readonly disabled?: boolean;
  readonly onSelect: (selection: ClientModelSelectionWithReasoning) => void;
  readonly onOpenSettings: () => void;
}

type Menu = "ROOT" | "MODELS" | "REASONING" | undefined;

export function ModelPicker(props: ModelPickerProps): ReactElement {
  const [menu, setMenu] = useState<Menu>(undefined);
  const selectedModel =
    props.selection === undefined
      ? undefined
      : (props.models.find(
          (model) =>
            model.provider === props.selection?.provider && model.id === props.selection?.model,
        ) ?? {
          provider: props.selection.provider,
          id: props.selection.model,
          displayName: `${props.selection.provider}/${props.selection.model}`,
          availability: "UNAVAILABLE" as const,
        });
  const hasConnectedProvider = props.providers.some((provider) => provider.credentialConfigured);
  const triggerLabel = pickerLabel(props.selection, selectedModel, hasConnectedProvider);
  const reasoning = selectedModel?.reasoning;

  return createElement(
    "div",
    { className: "model-picker" },
    createElement(
      "button",
      {
        type: "button",
        className: "model-picker-trigger",
        disabled: props.disabled,
        onClick: () => {
          if (!hasConnectedProvider && props.selection === undefined) {
            props.onOpenSettings();
            return;
          }
          setMenu(menu === undefined ? "ROOT" : undefined);
        },
        "aria-haspopup": "menu",
        "aria-expanded": menu !== undefined,
      },
      createElement(Settings2, { size: 15, strokeWidth: 2, "aria-hidden": true }),
      createElement("span", null, triggerLabel),
      createElement(ChevronDown, { size: 14, strokeWidth: 2.2, "aria-hidden": true }),
    ),
    menu === undefined
      ? null
      : createElement(
          "div",
          { className: "model-picker-menu", role: "menu" },
          menu === "ROOT"
            ? createRootMenu({
                selectedModel,
                reasoning,
                selection: props.selection,
                onModels: () => setMenu("MODELS"),
                onReasoning: () => setMenu("REASONING"),
              })
            : menu === "MODELS"
              ? createModelMenu({
                  providers: props.providers,
                  models: props.models,
                  selection: props.selection,
                  onBack: () => setMenu("ROOT"),
                  onSelect: (selection) => {
                    props.onSelect(selection);
                    setMenu(undefined);
                  },
                  onOpenSettings: () => {
                    setMenu(undefined);
                    props.onOpenSettings();
                  },
                })
              : createReasoningMenu({
                  model: selectedModel,
                  selection: props.selection,
                  onBack: () => setMenu("ROOT"),
                  onSelect: (selection) => {
                    props.onSelect(selection);
                    setMenu(undefined);
                  },
                }),
        ),
  );
}

function createRootMenu(input: {
  readonly selectedModel?: ModelView | undefined;
  readonly reasoning?: ModelView["reasoning"] | undefined;
  readonly selection?: ClientModelSelectionWithReasoning | undefined;
  readonly onModels: () => void;
  readonly onReasoning: () => void;
}): ReactElement {
  const selectedOption =
    input.reasoning?.options.find((option) => option.level === input.selection?.reasoningLevel) ??
    input.reasoning?.options.find(
      (option) => option.level === input.selectedModel?.reasoning?.defaultLevel,
    );
  return createElement(
    "div",
    { className: "model-picker-menu-list" },
    menuButton("模型", input.selectedModel?.displayName ?? "选择模型", input.onModels),
    input.reasoning === undefined
      ? null
      : menuButton(
          "推理强度",
          selectedOption?.displayName ?? "选择强度",
          input.onReasoning,
          selectedOption?.description,
        ),
  );
}

function createModelMenu(input: {
  readonly providers: readonly ProviderView[];
  readonly models: readonly ModelView[];
  readonly selection?: ClientModelSelectionWithReasoning | undefined;
  readonly onBack: () => void;
  readonly onSelect: (selection: ClientModelSelectionWithReasoning) => void;
  readonly onOpenSettings: () => void;
}): ReactElement {
  const groups = input.providers
    .map((provider) => ({
      provider,
      models: input.models.filter((model) => model.provider === provider.id),
    }))
    .filter((group) => group.models.length > 0);
  return createElement(
    "div",
    { className: "model-picker-menu-list" },
    menuBackButton("选择模型", input.onBack),
    groups.length === 0
      ? createElement(
          "button",
          { type: "button", className: "model-picker-empty", onClick: input.onOpenSettings },
          "连接 Provider 后发现模型",
        )
      : groups.map((group) =>
          createElement(
            "div",
            { className: "model-picker-group", key: group.provider.id },
            createElement(
              "span",
              { className: "model-picker-group-label" },
              group.provider.displayName,
            ),
            group.models.map((model) =>
              createElement(
                "button",
                {
                  type: "button",
                  className: `model-picker-item${
                    input.selection?.provider === model.provider &&
                    input.selection?.model === model.id
                      ? " model-picker-item--selected"
                      : ""
                  }`,
                  key: `${model.provider}/${model.id}`,
                  onClick: () => input.onSelect(selectionForModel(model, input.selection)),
                },
                createElement("span", null, model.displayName),
                model.reasoning === undefined
                  ? null
                  : createElement(ChevronRight, { size: 14, "aria-hidden": true }),
              ),
            ),
          ),
        ),
    createElement(
      "button",
      { type: "button", className: "model-picker-settings-link", onClick: input.onOpenSettings },
      "管理模型与 API",
    ),
  );
}

function createReasoningMenu(input: {
  readonly model?: ModelView | undefined;
  readonly selection?: ClientModelSelectionWithReasoning | undefined;
  readonly onBack: () => void;
  readonly onSelect: (selection: ClientModelSelectionWithReasoning) => void;
}): ReactElement {
  const options = input.model?.reasoning?.options ?? [];
  return createElement(
    "div",
    { className: "model-picker-menu-list" },
    menuBackButton("推理强度", input.onBack),
    options.map((option) =>
      createElement(
        "button",
        {
          type: "button",
          className: `model-picker-item${
            input.selection?.reasoningLevel === option.level ? " model-picker-item--selected" : ""
          }`,
          key: option.level,
          onClick: () => {
            if (input.model === undefined) return;
            input.onSelect({
              provider: input.model.provider,
              model: input.model.id,
              reasoningLevel: option.level,
            });
          },
        },
        createElement("span", null, option.displayName),
        option.description === undefined ? null : createElement("small", null, option.description),
      ),
    ),
  );
}

export function pickerLabel(
  selection: ClientModelSelectionWithReasoning | undefined,
  model: ModelView | undefined,
  hasConnectedProvider: boolean,
): string {
  if (!hasConnectedProvider && model === undefined) return "无";
  if (selection === undefined || model === undefined) return "选择模型";
  if (model.availability === "UNAVAILABLE") return `${model.displayName} · 不可用`;
  const reasoning = model.reasoning?.options.find(
    (option) => option.level === selection.reasoningLevel,
  );
  return reasoning === undefined
    ? model.displayName
    : `${model.displayName} · ${reasoning.displayName}`;
}

export function selectionForModel(
  model: ModelView,
  previous: ClientModelSelectionWithReasoning | undefined,
): ClientModelSelectionWithReasoning {
  const supported = model.reasoning?.options ?? [];
  const previousLevel =
    previous?.provider === model.provider && previous.model === model.id
      ? supported.find((option) => option.level === previous.reasoningLevel)?.level
      : undefined;
  const reasoningLevel = previousLevel ?? model.reasoning?.defaultLevel;
  return reasoningLevel === undefined
    ? { provider: model.provider, model: model.id }
    : { provider: model.provider, model: model.id, reasoningLevel };
}

function menuButton(
  label: string,
  value: string,
  onClick: () => void,
  description?: string,
): ReactElement {
  return createElement(
    "button",
    {
      type: "button",
      className: `model-picker-row${description === undefined ? "" : " model-picker-row--described"}`,
      onClick,
    },
    createElement("span", null, label),
    createElement("span", { className: "model-picker-row-value" }, value),
    createElement(ChevronRight, { size: 14, "aria-hidden": true }),
    description === undefined
      ? null
      : createElement("small", { className: "model-picker-row-description" }, description),
  );
}

function menuBackButton(label: string, onClick: () => void): ReactElement {
  return createElement(
    "button",
    { type: "button", className: "model-picker-back", onClick },
    createElement(ChevronLeft, { size: 14, "aria-hidden": true }),
    createElement("span", null, label),
  );
}
