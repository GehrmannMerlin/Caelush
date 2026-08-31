import type { ModelRef } from "@caelush/protocol";
import type { ModelPricingSnapshot } from "./budget-manager.js";

export interface PricingResolver {
  resolve(model: ModelRef): ModelPricingSnapshot | undefined;
}

export class StaticPricingResolver implements PricingResolver {
  constructor(private readonly entries: ReadonlyMap<string, ModelPricingSnapshot>) {}

  resolve(model: ModelRef): ModelPricingSnapshot | undefined {
    return this.entries.get(`${model.provider}/${model.model}`);
  }
}
