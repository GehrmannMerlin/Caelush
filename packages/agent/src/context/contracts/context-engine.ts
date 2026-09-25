/*
 * The external Context Engine seam was frozen before Phase 7A. This module is
 * only the target-path re-export; the declaration remains in the legacy
 * loop/context location so existing Phase 3 contract guards and consumers keep
 * one public identity while the target Kernel is built in parallel.
 */
export type {
  ContextEnginePort,
  ContextPrepareInput,
  ContextPrepareMode,
  ContextProvider,
  ContextProviderInput,
} from "../../loop/context/context-engine-port.js";
