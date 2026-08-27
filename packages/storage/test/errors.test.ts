import { describe, expect, it } from "vitest";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageMigrationError,
  StorageNotFoundError,
} from "../src/errors.js";

describe("Storage errors", () => {
  it("exposes distinct typed errors for storage boundaries", () => {
    expect(new StorageError("failure")).toBeInstanceOf(Error);
    expect(new StorageNotFoundError("AgentRun", "run-1")).toBeInstanceOf(StorageError);
    expect(new StorageConflictError("duplicate")).toBeInstanceOf(StorageError);
    expect(new StorageMigrationError("migration")).toBeInstanceOf(StorageError);
    expect(new StorageDecodeError("AgentRun", "run-1", "agent_runs")).toMatchObject({
      entityType: "AgentRun",
      entityId: "run-1",
      table: "agent_runs",
    });
  });
});
