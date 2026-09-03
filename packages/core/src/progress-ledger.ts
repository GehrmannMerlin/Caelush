export interface ProgressSignal {
  readonly kind:
    | "NEW_DISCOVERY"
    | "NEW_OBSERVATION"
    | "WORKSPACE_MUTATION"
    | "DIFF_CHANGED"
    | "VALIDATION_DELTA"
    | "VALIDATION_IMPROVEMENT"
    | "PROCESS_DELTA"
    | "PROJECT_FACT_DELTA";
}

export interface ProgressLedgerRecordInput {
  readonly turn: number;
  readonly requestFingerprint: string;
  readonly resultFingerprint: string;
  readonly signal?: ProgressSignal;
}

export interface ProgressObservation extends ProgressLedgerRecordInput {
  readonly progressed: boolean;
  readonly exactRepeat: boolean;
}

export interface ProgressLedgerSnapshot {
  readonly observations: readonly ProgressObservation[];
  readonly lastProgressTurn?: number;
  readonly consecutiveNoProgressTurns: number;
}

export class ProgressLedger {
  private readonly observations: ProgressObservation[] = [];
  private lastProgressTurn: number | undefined;
  private consecutiveNoProgressTurns = 0;

  constructor(
    private readonly options: { readonly maxTurns: number; readonly maxFingerprints: number },
  ) {
    assertPositiveInteger(options.maxTurns, "maxTurns");
    assertPositiveInteger(options.maxFingerprints, "maxFingerprints");
  }

  record(input: ProgressLedgerRecordInput): ProgressObservation {
    const previous = this.observations.at(-1);
    const exactRepeat =
      previous?.requestFingerprint === input.requestFingerprint &&
      previous.resultFingerprint === input.resultFingerprint;
    const progressed = input.signal !== undefined || (previous !== undefined && !exactRepeat);
    const observation: ProgressObservation = { ...input, progressed, exactRepeat };
    this.observations.push(observation);
    while (this.observations.length > this.options.maxFingerprints) this.observations.shift();
    while (
      this.observations.length > 0 &&
      input.turn - this.observations[0]!.turn >= this.options.maxTurns
    ) {
      this.observations.shift();
    }
    if (progressed) {
      this.lastProgressTurn = input.turn;
      this.consecutiveNoProgressTurns = 0;
    } else {
      this.consecutiveNoProgressTurns += 1;
    }
    return observation;
  }

  snapshot(): ProgressLedgerSnapshot {
    return {
      observations: this.observations.map((observation) => ({ ...observation })),
      ...(this.lastProgressTurn === undefined ? {} : { lastProgressTurn: this.lastProgressTurn }),
      consecutiveNoProgressTurns: this.consecutiveNoProgressTurns,
    };
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be positive.`);
}
