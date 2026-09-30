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
      { level: "LOW", displayName: "Low" },
      { level: "HIGH", displayName: "Deep" },
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

    expect(pickerLabel(selection, reasoningModel, true)).toBe("DeepSeek Reasoner · Deep");
    expect(html).toContain("DeepSeek Reasoner · Deep");
    expect(html).not.toContain("reasoning_effort");
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
