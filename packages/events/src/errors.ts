export class DuplicateEventError extends Error {
  constructor(eventId: string, options?: { cause?: unknown }) {
    super(`Event ${eventId} already exists`, options);
    this.name = "DuplicateEventError";
  }
}
