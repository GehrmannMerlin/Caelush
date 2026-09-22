import { CODING_TOOL_EFFECTS_EXTENSION_KIND } from "@caelush/agent";
import {
  applyToolEffectsToAgentState,
  createCodingToolSettlementExtensionDecoder,
  effectsChangeAgentState,
  type ToolEffect,
} from "@caelush/coding-agent";
import { openCaelushStorage } from "../../src/index.js";

/**
 * The production Tool settlement extension decoder, for storage tests.
 *
 * `@caelush/storage` takes the decoder as a constructor dependency rather than importing it, because
 * the Coding effect vocabulary belongs to the Coding overlay. The daemon composition wires it in
 * production; a storage test that commits effects wires the same implementation in here, so the
 * projection under test is the production one and not a test-only stand-in.
 *
 * Phase 4F deleted the legacy Tool System package, so the decoder now comes from
 * `@caelush/coding-agent` — the package that owns the effect vocabulary — and the two projection
 * functions it delegates to are that package's own `effectsChangeAgentState` /
 * `applyToolEffectsToAgentState`. The algorithm is unchanged: the decoder is pure, synchronous, and
 * owns no transaction, so the effects it returns are still handed to the same single `commit` call as
 * the terminal invocation.
 */
export function toolSettlementExtensionDecoder() {
  return createCodingToolSettlementExtensionDecoder({
    effects: {
      changesState: (effects) => effectsChangeAgentState(effects as readonly ToolEffect[]),
      apply: (state, effects, now) =>
        applyToolEffectsToAgentState(state, effects as readonly ToolEffect[], now),
    },
  });
}

/** The settlement extension an effect-producing Tool result carries. */
export function codingEffectsExtension(effects: readonly ToolEffect[]) {
  return Object.freeze({
    kind: CODING_TOOL_EFFECTS_EXTENSION_KIND,
    payload: Object.freeze({ effects: effects as unknown as never }),
  });
}

/**
 * Open the durable store with the production Tool settlement decoder wired in.
 *
 * Every storage test that runs a real Tool through the durable path needs the same wiring the daemon
 * composition performs, so it lives in one place rather than being repeated per file.
 */
export async function openToolStorage(options: Parameters<typeof openCaelushStorage>[0]) {
  return await openCaelushStorage({
    ...options,
    toolSettlementExtension: options.toolSettlementExtension ?? toolSettlementExtensionDecoder(),
  });
}
