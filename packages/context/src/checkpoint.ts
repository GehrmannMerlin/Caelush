export interface CheckpointSourceRange {
  readonly from: number;
  readonly to: number;
  readonly kind?: "DURABLE_MESSAGE_SEQUENCE" | "LOCAL_HISTORY_INDEX";
}

export interface StructuredCheckpointInput {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly completedWork: readonly string[];
  readonly inProgress: readonly string[];
  readonly blocked: readonly string[];
  readonly importantDiscoveries: readonly string[];
  readonly keyDecisions: readonly string[];
  readonly changedFiles: readonly string[];
  readonly readFiles: readonly string[];
  readonly recentErrors: readonly string[];
  readonly verificationState: string;
  readonly activeProcesses: readonly string[];
  readonly pendingApprovals: readonly string[];
  readonly resourceGovernance: string;
  readonly criticalReferences: readonly string[];
  readonly nextIntent: string;
  readonly sourceRange: CheckpointSourceRange;
}

export interface StructuredCheckpoint extends StructuredCheckpointInput {
  readonly version: 1;
}

const MAX_TEXT_BYTES = 100_000;
const MAX_LIST_ITEMS = 128;
const MAX_ITEM_BYTES = 4096;

function boundedText(name: string, value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new RangeError(`${name} exceeds checkpoint byte limit`);
  }
}

function boundedList(name: string, values: readonly string[]): readonly string[] {
  if (values.length > MAX_LIST_ITEMS) throw new RangeError(`${name} exceeds checkpoint item limit`);
  for (const value of values) {
    if (Buffer.byteLength(value, "utf8") > MAX_ITEM_BYTES) {
      throw new RangeError(`${name} contains an oversized item`);
    }
  }
  return Object.freeze([...values]);
}

export function createStructuredCheckpoint(input: StructuredCheckpointInput): StructuredCheckpoint {
  boundedText("goal", input.goal);
  boundedText("verificationState", input.verificationState);
  boundedText("resourceGovernance", input.resourceGovernance);
  boundedText("nextIntent", input.nextIntent);
  if (input.goal.length === 0) throw new RangeError("goal must not be empty");
  if (
    !Number.isSafeInteger(input.sourceRange.from) ||
    !Number.isSafeInteger(input.sourceRange.to) ||
    input.sourceRange.from > input.sourceRange.to
  ) {
    throw new RangeError("sourceRange is invalid");
  }
  return Object.freeze({
    version: 1,
    goal: input.goal,
    constraints: boundedList("constraints", input.constraints),
    completedWork: boundedList("completedWork", input.completedWork),
    inProgress: boundedList("inProgress", input.inProgress),
    blocked: boundedList("blocked", input.blocked),
    importantDiscoveries: boundedList("importantDiscoveries", input.importantDiscoveries),
    keyDecisions: boundedList("keyDecisions", input.keyDecisions),
    changedFiles: boundedList("changedFiles", input.changedFiles),
    readFiles: boundedList("readFiles", input.readFiles),
    recentErrors: boundedList("recentErrors", input.recentErrors),
    verificationState: input.verificationState,
    activeProcesses: boundedList("activeProcesses", input.activeProcesses),
    pendingApprovals: boundedList("pendingApprovals", input.pendingApprovals),
    resourceGovernance: input.resourceGovernance,
    criticalReferences: boundedList("criticalReferences", input.criticalReferences),
    nextIntent: input.nextIntent,
    sourceRange: Object.freeze({
      ...input.sourceRange,
      kind: input.sourceRange.kind ?? "LOCAL_HISTORY_INDEX",
    }),
  });
}

export interface MinimalCheckpointInput {
  readonly goal: string;
  readonly changedFiles: readonly string[];
  readonly recentErrors: readonly string[];
  readonly verificationState: string;
  readonly sourceRange: CheckpointSourceRange;
}

export function createDeterministicMinimalCheckpoint(
  input: MinimalCheckpointInput,
): StructuredCheckpoint {
  return createStructuredCheckpoint({
    goal: input.goal,
    constraints: [],
    completedWork: [],
    inProgress: [],
    blocked: [],
    importantDiscoveries: [],
    keyDecisions: [],
    changedFiles: input.changedFiles,
    readFiles: [],
    recentErrors: input.recentErrors,
    verificationState: input.verificationState,
    activeProcesses: [],
    pendingApprovals: [],
    resourceGovernance: "",
    criticalReferences: [],
    nextIntent: "continue from the recent execution tail",
    sourceRange: input.sourceRange,
  });
}
