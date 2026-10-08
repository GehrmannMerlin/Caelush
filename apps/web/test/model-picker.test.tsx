import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelView, ProviderView } from "@caelush/protocol";
import { ModelPicker, pickerLabel, selectionForModel } from "../src/components/model-picker.js";

const provider: ProviderView = {
  id: "deepseek",
  displayName: "DeepSeek",
  credentialConfigured: true,
  credentialSource: "LOCAL",
  credentialWritable: true,
  discoveryState: "READY",
};

const reasoningModel: ModelView = {
  provider: "deepseek",
  id: "deepseek-reasoner",
  displayName: "DeepSeek Reasoner",
  availability: "AVAILABLE",
  reasoning: {
    defaultLevel: "HIGH",
    options: [
      { level: "OFF", displayName: "Auto", description: "使用模型默认推理策略" },
      { level: "MINIMAL", displayName: "Minimal", description: "速度优先" },
      { level: "LOW", displayName: "Low", description: "速度优先，适合简单编辑" },
      { level: "MEDIUM", displayName: "Medium", description: "适合复杂调试" },
      { level: "HIGH", displayName: "High", description: "适合多文件修改" },
      { level: "XHIGH", displayName: "Max", description: "最高推理强度，可能增加等待时间" },
    ],
  },
};

describe("web model picker", () => {
  it("shows 无 when no Provider is connected", () => {
    const html = renderToStaticMarkup(
      <ModelPicker providers={[]} models={[]} onSelect={vi.fn()} onOpenSettings={vi.fn()} />,
    );

    expect(html).toContain("无");
  });

  it("shows 选择模型 when a Provider exists but no model is selected", () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        providers={[provider]}
        models={[reasoningModel]}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(html).toContain("选择模型");
  });

  it("projects the selected model and canonical reasoning presentation", () => {
    const selection = {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningLevel: "HIGH" as const,
    };
    const html = renderToStaticMarkup(
      <ModelPicker
        providers={[provider]}
        models={[reasoningModel]}
        selection={selection}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(pickerLabel(selection, reasoningModel, true)).toBe("DeepSeek Reasoner · High");
    expect(
      pickerLabel(
        { provider: "deepseek", model: "deepseek-reasoner", reasoningLevel: "OFF" },
        reasoningModel,
        true,
      ),
    ).toBe("DeepSeek Reasoner · Auto");
    expect(
      pickerLabel(
        { provider: "deepseek", model: "deepseek-reasoner", reasoningLevel: "XHIGH" },
        reasoningModel,
        true,
      ),
    ).toBe("DeepSeek Reasoner · Max");
    expect(html).toContain("DeepSeek Reasoner · High");
    expect(html).not.toContain("reasoning_effort");
  });

  it("keeps the explicit same-model level and uses a new model's own default", () => {
    const maxSelection = {
      provider: "deepseek",
      model: "deepseek-reasoner",
      reasoningLevel: "XHIGH" as const,
    };
    expect(selectionForModel(reasoningModel, maxSelection)).toEqual(maxSelection);

    const nextModel: ModelView = {
      provider: "deepseek",
      id: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      availability: "AVAILABLE",
      reasoning: {
        defaultLevel: "HIGH",
        options: [{ level: "HIGH", displayName: "High" }],
      },
    };
    expect(selectionForModel(nextModel, maxSelection)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningLevel: "HIGH",
    });
  });

  it("does not invent reasoning options for an unsupported model", () => {
    const unsupportedModel: ModelView = {
      provider: "deepseek",
      id: "deepseek-chat",
      displayName: "DeepSeek Chat",
      availability: "AVAILABLE",
    };
    const selection = { provider: "deepseek", model: "deepseek-chat" };

    expect(selectionForModel(unsupportedModel, undefined)).toEqual(selection);
    expect(pickerLabel(selection, unsupportedModel, true)).toBe("DeepSeek Chat");
  });

  it("drops an incompatible reasoning level when the model changes", () => {
    const nextModel: ModelView = {
      provider: "deepseek",
      id: "deepseek-chat",
      displayName: "DeepSeek Chat",
      availability: "AVAILABLE",
      reasoning: { options: [{ level: "LOW", displayName: "Fast" }], defaultLevel: "LOW" },
    };

    expect(
      selectionForModel(nextModel, {
        provider: "deepseek",
        model: "deepseek-reasoner",
        reasoningLevel: "HIGH",
      }),
    ).toEqual({ provider: "deepseek", model: "deepseek-chat", reasoningLevel: "LOW" });
  });
});
