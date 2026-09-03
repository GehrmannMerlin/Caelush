import { createHash } from "node:crypto";
import type { JsonObject } from "@caelush/protocol";
import type { TokenEstimator } from "./token-estimator.js";

export type ArtifactSensitivity = "PUBLIC" | "INTERNAL" | "SENSITIVE";

export interface Artifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly kind: string;
  readonly sourceRef: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly createdSequence: number;
  readonly createdAt: number;
  readonly sensitivity: ArtifactSensitivity;
  readonly content: string;
}

export interface ArtifactPutInput {
  readonly runId: string;
  readonly kind: string;
  readonly sourceRef: string;
  readonly content: string;
  readonly mimeType: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly createdSequence: number;
  readonly createdAt: number;
}

export interface ArtifactStore {
  put(input: ArtifactPutInput): Promise<Artifact>;
  get(artifactId: string): Promise<Artifact | undefined>;
}

export interface ModelObservation {
  readonly sourceToolInvocationId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly structuredFacts?: JsonObject;
  readonly references: readonly string[];
  readonly truncated: boolean;
  readonly rawArtifactRef?: string;
  readonly tokenEstimate: number;
  readonly observationHash: string;
}

export interface ProjectToolObservationInput {
  readonly sourceToolInvocationId: string;
  readonly toolName: string;
  readonly content: string;
  readonly structuredFacts?: JsonObject;
  readonly references?: readonly string[];
  readonly rawArtifactRef?: string;
  readonly maxObservationTokens: number;
  readonly estimator: TokenEstimator;
}

const OMITTED = "\n[output omitted; see artifact]";

function boundedPrefix(content: string, maxTokens: number, estimator: TokenEstimator): string {
  const characters = [...content];
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (estimator.estimateText(candidate) <= maxTokens) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function boundObservation(
  content: string,
  toolName: string,
  maxTokens: number,
  estimator: TokenEstimator,
): { readonly text: string; readonly truncated: boolean } {
  if (estimator.estimateText(content) <= maxTokens) return { text: content, truncated: false };
  const marker = estimator.estimateText(OMITTED) <= maxTokens ? OMITTED : "[omitted]";
  const available = Math.max(0, maxTokens - estimator.estimateText(marker));
  if (toolName === "exec_command" || toolName === "write_stdin") {
    const characters = [...content];
    const half = Math.floor(available / 2);
    const head = boundedPrefix(content, half, estimator);
    const tail = boundedPrefix(
      characters.slice(Math.max(0, characters.length - Math.max(1, half))).join(""),
      available - estimator.estimateText(head),
      estimator,
    );
    return { text: `${head}${marker}${tail}`, truncated: true };
  }
  return { text: `${boundedPrefix(content, available, estimator)}${marker}`, truncated: true };
}

export function projectToolObservation(input: ProjectToolObservationInput): ModelObservation {
  if (input.sourceToolInvocationId.trim() === "" || input.toolName.trim() === "") {
    throw new RangeError("Tool observation identity must not be empty");
  }
  if (!Number.isSafeInteger(input.maxObservationTokens) || input.maxObservationTokens < 1) {
    throw new RangeError("maxObservationTokens must be a positive safe integer");
  }
  const bounded = boundObservation(
    input.content,
    input.toolName,
    input.maxObservationTokens,
    input.estimator,
  );
  const observationHash = createHash("sha256")
    .update(
      JSON.stringify({
        sourceToolInvocationId: input.sourceToolInvocationId,
        toolName: input.toolName,
        summary: bounded.text,
        truncated: bounded.truncated,
      }),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({
    sourceToolInvocationId: input.sourceToolInvocationId,
    toolName: input.toolName,
    summary: bounded.text,
    ...(input.structuredFacts === undefined ? {} : { structuredFacts: input.structuredFacts }),
    references: Object.freeze([...(input.references ?? [])]),
    truncated: bounded.truncated,
    ...(input.rawArtifactRef === undefined ? {} : { rawArtifactRef: input.rawArtifactRef }),
    tokenEstimate: input.estimator.estimateText(bounded.text),
    observationHash,
  });
}

export function createInMemoryArtifactStore(): ArtifactStore {
  const artifacts = new Map<string, Artifact>();
  return {
    async put(input) {
      const contentHash = createHash("sha256").update(input.content, "utf8").digest("hex");
      const artifactId = `artifact:${contentHash}`;
      const artifact: Artifact = Object.freeze({
        artifactId,
        runId: input.runId,
        kind: input.kind,
        sourceRef: input.sourceRef,
        contentHash,
        byteLength: Buffer.byteLength(input.content, "utf8"),
        mimeType: input.mimeType,
        createdSequence: input.createdSequence,
        createdAt: input.createdAt,
        sensitivity: input.sensitivity,
        content: input.content,
      });
      artifacts.set(artifactId, artifact);
      return artifact;
    },
    async get(artifactId) {
      return artifacts.get(artifactId);
    },
  };
}
