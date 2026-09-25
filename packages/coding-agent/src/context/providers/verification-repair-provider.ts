import type { ContextSourceInput, ContextSourceProvider } from "@caelush/agent";

import type { VerificationRepairContextPort } from "../ports.js";
import {
  assertBoundedText,
  assertSafeOpaqueReference,
  createCodingSourceResult,
  createCodingTextItem,
  resolveCodingTokenEstimator,
  type CodingContextProviderOptions,
} from "../provider-helpers.js";
import { CODING_CONTEXT_SOURCE_IDS } from "../source-ids.js";

const PROVIDER_VERSION = "verification-repair-v1";
const MAX_REPAIR_BYTES = 32 * 1024;

export interface VerificationRepairContextSourceProviderOptions extends CodingContextProviderOptions {
  readonly port?: VerificationRepairContextPort;
}

export function createVerificationRepairContextSourceProvider(
  options: VerificationRepairContextSourceProviderOptions = {},
): ContextSourceProvider {
  const tokenEstimator = resolveCodingTokenEstimator(options);
  return Object.freeze({
    id: CODING_CONTEXT_SOURCE_IDS.verificationRepair,
    async collect(input: ContextSourceInput) {
      const projection = await options.port?.read({
        identity: input.identity,
        signal: input.signal,
      });
      if (projection === undefined) {
        return createCodingSourceResult(
          CODING_CONTEXT_SOURCE_IDS.verificationRepair,
          PROVIDER_VERSION,
          [],
        );
      }
      assertSafeOpaqueReference(projection.sourceRef, "Verification repair sourceRef");
      if (projection.repairRef !== undefined) {
        assertBoundedText(projection.repairRef, 1024, "Verification repair reference");
      }
      assertBoundedText(projection.text, MAX_REPAIR_BYTES, "Verification repair evidence");
      const item = createCodingTextItem({
        id: `coding.verification-repair:${projection.repairRef ?? projection.sourceRef}`,
        providerId: CODING_CONTEXT_SOURCE_IDS.verificationRepair,
        sourceRef: projection.sourceRef,
        version: projection.version,
        type: "coding.verification_repair",
        scope: "TURN",
        retention: "EPHEMERAL",
        priorityClass: "NORMAL",
        cacheStability: "DYNAMIC",
        freshness: "CURRENT",
        sensitivity: "INTERNAL",
        whyLoaded: "bounded verification repair diagnostic",
        text: projection.text,
        input,
        tokenEstimator,
      });
      return createCodingSourceResult(
        CODING_CONTEXT_SOURCE_IDS.verificationRepair,
        PROVIDER_VERSION,
        [item],
      );
    },
  });
}
