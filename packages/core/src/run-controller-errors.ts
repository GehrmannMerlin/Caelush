import type { RunId } from "@caelush/protocol";

/**
 * The Run Controller's own error vocabulary.
 *
 * A caller-supplied value that could not be executed, a Run that is already being driven, a
 * durable record that moved under a transition, and a violated invariant are four different
 * failures and stay four different classes. They live here — apart from the controller — so the
 * Run Layer's Tool turn adapter and its security projection can refuse something the same way the
 * controller does, instead of each declaring a private error that `instanceof` would not agree
 * with.
 *
 * None of them carries a Cause by default and none of them ever includes raw arguments, Tool
 * output, credentials or provider text in its message.
 */

export class RunControllerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunControllerInputError";
  }
}

export class RunControllerBusyError extends Error {
  constructor(runId: RunId) {
    super(`Run ${runId} is already being executed`);
    this.name = "RunControllerBusyError";
  }
}

export class RunControllerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunControllerConflictError";
  }
}

export class RunControllerInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunControllerInfrastructureError";
  }
}

export class RunControllerInvariantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunControllerInvariantError";
  }
}
