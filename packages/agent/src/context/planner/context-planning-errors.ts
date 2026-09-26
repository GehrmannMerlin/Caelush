export type ContextPlanningErrorCode =
  | "INVALID_CONTEXT_ITEM"
  | "DUPLICATE_ITEM_ID"
  | "UNKNOWN_ITEM_REFERENCE"
  | "BROKEN_ATOMIC_GROUP"
  | "INCONSISTENT_PLAN"
  | "MANDATORY_INPUT_TOO_LARGE"
  | "CURRENT_TURN_TOO_LARGE";

/** A bounded planning failure that never includes Context payloads. */
export class ContextPlanningError extends Error {
  readonly code: ContextPlanningErrorCode;
  readonly itemId?: string;
  readonly sourceId?: string;

  constructor(
    code: ContextPlanningErrorCode,
    details: { readonly itemId?: string; readonly sourceId?: string } = {},
  ) {
    super(contextPlanningErrorMessage(code));
    this.name = "ContextPlanningError";
    this.code = code;
    if (details.itemId !== undefined) this.itemId = details.itemId;
    if (details.sourceId !== undefined) this.sourceId = details.sourceId;
  }
}

/** A mandatory item/group cannot be safely removed to fit the input window. */
export class ContextMandatoryInputTooLargeError extends ContextPlanningError {
  constructor(details: { readonly itemId?: string; readonly sourceId?: string } = {}) {
    super("MANDATORY_INPUT_TOO_LARGE", details);
    this.name = "ContextMandatoryInputTooLargeError";
  }
}

/** The current user turn itself cannot fit and must not be silently truncated. */
export class ContextCurrentTurnTooLargeError extends ContextPlanningError {
  constructor(details: { readonly itemId?: string; readonly sourceId?: string } = {}) {
    super("CURRENT_TURN_TOO_LARGE", details);
    this.name = "ContextCurrentTurnTooLargeError";
  }
}

/** The final V2 context still cannot fit without violating a mandatory invariant. */
export class ContextExhaustedError extends Error {
  readonly code = "CONTEXT_EXHAUSTED" as const;

  constructor() {
    super("The model context is exhausted and cannot be reduced safely.");
    this.name = "ContextExhaustedError";
  }
}

function contextPlanningErrorMessage(code: ContextPlanningErrorCode): string {
  switch (code) {
    case "INVALID_CONTEXT_ITEM":
      return "A ContextItem failed bounded validation.";
    case "DUPLICATE_ITEM_ID":
      return "The planning input contains a duplicate ContextItem id.";
    case "UNKNOWN_ITEM_REFERENCE":
      return "A ContextItem refers to a message absent from the semantic history index.";
    case "BROKEN_ATOMIC_GROUP":
      return "A semantic history group has inconsistent atomic identity.";
    case "INCONSISTENT_PLAN":
      return "The ContextPlan is internally inconsistent.";
    case "MANDATORY_INPUT_TOO_LARGE":
      return "Mandatory context cannot fit the effective input budget.";
    case "CURRENT_TURN_TOO_LARGE":
      return "The current user turn cannot fit the effective input budget.";
  }
}
