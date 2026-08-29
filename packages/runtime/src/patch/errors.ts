import { RuntimeError, type RuntimeErrorCode } from "../runtime-errors.js";

export type RuntimePatchErrorCode = Exclude<RuntimeErrorCode, "PATCH_UNCERTAIN">;

export class RuntimePatchError extends RuntimeError {
  constructor(code: RuntimePatchErrorCode, message = `Patch operation failed: ${code}.`) {
    super(code, message);
  }
}

export class RuntimePatchUncertainError extends RuntimeError {
  constructor(message = "Patch side effects could not be verified safely.") {
    super("PATCH_UNCERTAIN", message);
  }
}
