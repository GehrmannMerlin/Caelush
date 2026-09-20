import { openCaelushStorage } from "../../src/index.js";
import {
  applyToolEffectsToAgentState,
  createLegacyToolSettlementExtensionDecoder,
  effectsChangeAgentState,
  type ToolEffect,
} from "@caelush/tools";

/**
 * The production Tool settlement extension decoder, for storage tests.
 *
 * `@caelush/storage` takes the decoder as a constructor dependency rather than importing it, because
 * the Coding effect vocabulary belongs to the Tool System. The daemon composition wires it in
 * production; a storage test that commits effects wires the same implementation in here, so the
 * projection under test is the production one and not a test-only stand-in.
 */
export function toolSettlementExtensionDecoder() {
  return createLegacyToolSettlementExtensionDecoder({
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
    kind: "caelush.coding.effects.v1" as const,
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
