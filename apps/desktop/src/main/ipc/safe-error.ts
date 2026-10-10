import { AccountOperationError } from "../account/controller.js";
import { CloudClientError } from "../cloud/client.js";

export interface SafeIpcError {
  readonly code: string;
  readonly message: string;
}

export function safeErrorForIpc(error: unknown): SafeIpcError {
  if (error instanceof AccountOperationError || error instanceof CloudClientError) {
    return { code: error.code.slice(0, 64), message: error.message.slice(0, 512) };
  }
  return { code: "REQUEST_FAILED", message: "The desktop request could not be completed." };
}
