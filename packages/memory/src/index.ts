import { createHash } from "node:crypto";

export type MemoryScope = "PROJECT" | "GLOBAL";
export type MemoryStatus = "ACTIVE" | "STALE" | "SUPERSEDED" | "INVALID" | "EXPIRED";
export type MemorySensitivity = "PUBLIC" | "INTERNAL" | "SENSITIVE";

export interface MemoryCandidate {
  readonly scope: MemoryScope;
  readonly projectId?: string;
  readonly topic: string;
  readonly fact: string;
  readonly confidence: number;
  readonly evidenceRefs: readonly string[];
  readonly sourceRunIds?: readonly string[];
  readonly sensitivity: MemorySensitivity;
}

export interface MemoryRecord extends MemoryCandidate {
  readonly id: string;
  readonly status: MemoryStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastConfirmedAt: number;
  readonly supersedes?: string;
  readonly supersededBy?: string;
  readonly schemaVersion: 1;
}

const SECRET_PATTERN =
  /(?:api[_-]?key|secret|token|password|credential|authorization|bearer)\s*[:=]/iu;

export function classifyMemorySensitivity(text: string): MemorySensitivity {
  return SECRET_PATTERN.test(text) ? "SENSITIVE" : "PUBLIC";
}

export function validateMemoryCandidate(input: MemoryCandidate): void {
  if (input.topic.trim() === "" || input.fact.trim() === "") {
    throw new RangeError("memory topic and fact must not be empty");
  }
  if (
    input.scope === "PROJECT" &&
    (input.projectId === undefined || input.projectId.trim() === "")
  ) {
    throw new RangeError("project memory requires projectId");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new RangeError("memory confidence must be between 0 and 1");
  }
  if (input.evidenceRefs.length === 0) throw new RangeError("memory requires evidence");
  if (input.sensitivity === "SENSITIVE" || classifyMemorySensitivity(input.fact) === "SENSITIVE") {
    throw new RangeError("sensitive content cannot be stored as memory");
  }
}

export function createMemoryRecord(candidate: MemoryCandidate, now: number): MemoryRecord {
  validateMemoryCandidate(candidate);
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("memory timestamp is invalid");
  const hash = createHash("sha256")
    .update(JSON.stringify({ ...candidate, now }), "utf8")
    .digest("hex");
  return Object.freeze({
    ...candidate,
    ...(candidate.sourceRunIds === undefined ? {} : { sourceRunIds: [...candidate.sourceRunIds] }),
    id: `memory:${hash}`,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: now,
    schemaVersion: 1,
  });
}

export interface MemoryStore {
  save(candidate: MemoryCandidate): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | undefined>;
  list(): Promise<readonly MemoryRecord[]>;
  supersede(id: string, replacementId: string): Promise<void>;
  forget(id: string): Promise<void>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async save(candidate: MemoryCandidate): Promise<MemoryRecord> {
    const now = this.now();
    const record = createMemoryRecord(candidate, now);
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    return this.records.get(id);
  }

  async list(): Promise<readonly MemoryRecord[]> {
    return [...this.records.values()];
  }

  async supersede(id: string, replacementId: string): Promise<void> {
    const current = this.records.get(id);
    const replacement = this.records.get(replacementId);
    if (current === undefined || replacement === undefined)
      throw new Error("memory record not found");
    this.records.set(
      id,
      Object.freeze({
        ...current,
        status: "SUPERSEDED",
        supersededBy: replacementId,
        updatedAt: this.now(),
      }),
    );
    this.records.set(replacementId, Object.freeze({ ...replacement, supersedes: id }));
  }

  async forget(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export interface MemoryRetrievalInput {
  readonly scope: MemoryScope;
  readonly projectId?: string;
  readonly goal: string;
  readonly maxItems: number;
  readonly maxTokens?: number;
}

export class MemoryRetriever {
  constructor(private readonly store: MemoryStore) {}

  async retrieve(input: MemoryRetrievalInput): Promise<readonly MemoryRecord[]> {
    const tokens = new Set(
      input.goal
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter(Boolean),
    );
    const records = (await this.store.list())
      .filter(
        (record) =>
          record.status === "ACTIVE" &&
          record.scope === input.scope &&
          (record.scope === "GLOBAL" || record.projectId === input.projectId),
      )
      .map((record) => ({
        record,
        score: [
          ...`${record.topic} ${record.fact}`.toLocaleLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu),
        ].reduce((score, match) => score + (tokens.has(match[0] ?? "") ? 1 : 0), 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || right.record.confidence - left.record.confidence,
      );
    const selected: MemoryRecord[] = [];
    let usedTokens = 0;
    for (const entry of records.slice(0, Math.max(0, input.maxItems))) {
      const estimatedTokens = Math.max(
        1,
        Math.ceil(`${entry.record.topic}: ${entry.record.fact}`.length / 4),
      );
      if (input.maxTokens !== undefined && usedTokens + estimatedTokens > input.maxTokens) continue;
      selected.push(entry.record);
      usedTokens += estimatedTokens;
    }
    return selected;
  }
}

export {
  createMemoryExtractionJob,
  type MemoryExtractionJob,
  type MemoryExtractionJobCreateInput,
  type MemoryExtractionJobStatus,
  type MemoryExtractionJobStore,
} from "./extraction-job.js";
