import { StorageConflictError } from "@caelush/storage";

export class WorkspaceOwnershipError extends Error {
  constructor(message = "The Session must have a registered Workspace owner.") {
    super(message);
    this.name = "WorkspaceOwnershipError";
  }
}

export class ActiveRunConflictError extends StorageConflictError {
  constructor() {
    super("The Workspace has an active Run and cannot be forgotten.");
    this.name = "ActiveRunConflictError";
  }
}
