import {
  CaelushClientHttpError,
  CaelushClientProtocolError,
  CaelushProtocolCompatibilityError,
} from "@caelush/client";

export function toSafeCliError(error: unknown): string {
  if (error instanceof CaelushClientHttpError) return error.message;
  if (error instanceof CaelushProtocolCompatibilityError) {
    return "Daemon protocol compatibility check failed.";
  }
  if (error instanceof CaelushClientProtocolError) {
    if (error.message.startsWith("Daemon request failed")) {
      return "Caelush Local Agent Service is not reachable.";
    }
    return "Daemon protocol compatibility check failed.";
  }
  return "Caelush could not complete the requested operation.";
}
