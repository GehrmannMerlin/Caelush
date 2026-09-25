export class ControlHookAbortedError extends Error {
  constructor() {
    super("Control Hook execution was cancelled.");
    this.name = "ControlHookAbortedError";
  }
}

export class ControlHookTimeoutError extends Error {
  constructor() {
    super("Control Hook execution timed out.");
    this.name = "ControlHookTimeoutError";
  }
}

export class ControlHookReentrancyError extends Error {
  constructor(pipelineId: string) {
    super(`Control Hook pipeline re-entry is not allowed: ${pipelineId}.`);
    this.name = "ControlHookReentrancyError";
  }
}

export class ControlHookPipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlHookPipelineError";
  }
}
