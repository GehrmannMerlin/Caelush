import type { ArchiveDeletionCommit } from "@caelush/storage";
import type { RunEventHub } from "../events/run-event-hub.js";

/** The history services read Storage on every request; only Hub subscriptions retain history. */
export class ArchiveInvalidator {
  constructor(
    private readonly options: { readonly eventHub: Pick<RunEventHub, "invalidateRuns"> },
  ) {}
  invalidate(commit: ArchiveDeletionCommit): void {
    this.options.eventHub.invalidateRuns(commit.deletedRunIds);
  }
}
