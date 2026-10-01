import type { EffectPathRelation, RecursiveDeleteResolution } from "./effect-assessment.js";

export type RecursiveDeleteReasonCode = "RECURSIVE_DELETE_UNRESOLVED" | "PROTECTED_ROOT_MUTATION";

export type RecursiveDeleteAssessment =
  | {
      readonly kind: "ALLOW";
      readonly reasonCode: "RECURSIVE_DELETE_WITHIN_RESOLVED_BOUNDARY";
      readonly safeReason: string;
    }
  | {
      readonly kind: "DENY";
      readonly reasonCode: RecursiveDeleteReasonCode;
      readonly safeReason: string;
    };

export interface RecursiveDeleteEffect {
  readonly recursive: boolean;
  readonly resolution: RecursiveDeleteResolution;
  readonly relation: EffectPathRelation;
}

export function classifyRecursiveDelete(effect: RecursiveDeleteEffect): RecursiveDeleteAssessment {
  if (effect.relation === "PROTECTED_ROOT") {
    return {
      kind: "DENY",
      reasonCode: "PROTECTED_ROOT_MUTATION",
      safeReason: "Recursive mutation of a protected system or home root is denied.",
    };
  }
  if (effect.recursive && (effect.resolution === "DYNAMIC" || effect.resolution === "UNKNOWN")) {
    return {
      kind: "DENY",
      reasonCode: "RECURSIVE_DELETE_UNRESOLVED",
      safeReason: "Recursive deletion is denied until every target is resolved and bounded.",
    };
  }
  return {
    kind: "ALLOW",
    reasonCode: "RECURSIVE_DELETE_WITHIN_RESOLVED_BOUNDARY",
    safeReason: "The delete target is resolved and can continue through the preset boundary check.",
  };
}
