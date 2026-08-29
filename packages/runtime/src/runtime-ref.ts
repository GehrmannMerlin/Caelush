import type { RuntimeRef } from "@caelush/protocol";
import type { Runtime } from "./runtime.js";

export const LOCAL_RUNTIME_KIND = "local";

export interface RuntimeResolver {
  resolve(ref: RuntimeRef): Runtime | undefined;
}

export class SingleRuntimeResolver implements RuntimeResolver {
  constructor(private readonly runtime: Runtime) {}

  resolve(ref: RuntimeRef): Runtime | undefined {
    return this.runtime.supports(ref) ? this.runtime : undefined;
  }
}

export function createLocalRuntimeResolver(runtime: Runtime): RuntimeResolver {
  return new SingleRuntimeResolver(runtime);
}
