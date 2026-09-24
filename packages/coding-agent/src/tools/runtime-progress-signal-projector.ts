import type { ToolExecutionUpdate } from "@caelush/agent";
import {
  ProcessOutputEventV2Schema,
  ShellOutputEventV2Schema,
  ToolOutputEventV2Schema,
  type EventId,
  type SessionId,
  type TimestampMs,
  type ToolInvocation,
  type ToolName,
  type TransientRunEvent,
} from "@caelush/protocol";

export interface CodingRuntimeProgressEnvelope {
  readonly sessionId: SessionId;
  readonly toolName: ToolName;
  readonly invocation: ToolInvocation;
  /** This update has already passed the Agent/Security sanitizer. */
  readonly update: ToolExecutionUpdate;
}

export interface RuntimeProgressSignalProjector {
  project(input: CodingRuntimeProgressEnvelope): TransientRunEvent | null;
  projectMany?(input: CodingRuntimeProgressEnvelope): readonly TransientRunEvent[];
}

export interface RuntimeProgressSignalProjectorDependencies {
  readonly eventIdFactory: { create(): EventId };
  readonly clock: { now(): TimestampMs };
}

/**
 * Projects sanitized Coding Tool output onto the canonical live event domain.
 *
 * The instance is bound to one invocation executor, so its stream sequence map cannot grow with
 * daemon lifetime. `write_stdin` uses the already persisted/prepared `session_id` argument as the
 * process identity; an absent or malformed identity is dropped rather than guessed from an
 * invocation id.
 */
export function createRuntimeProgressSignalProjector(
  dependencies: RuntimeProgressSignalProjectorDependencies,
): RuntimeProgressSignalProjector {
  const streamSequences = new Map<string, number>();

  const projectMany = (input: CodingRuntimeProgressEnvelope): readonly TransientRunEvent[] => {
    if (input.update.kind !== "OUTPUT") return [];
    const output = input.update;
    return splitTransientText(output.chunk).flatMap((chunk) => {
      const { invocation, toolName } = input;
      const { stream } = output;

      if (toolName === "exec_command") {
        const streamKey = `shell:${invocation.id}`;
        return [
          ShellOutputEventV2Schema.parse({
            ...base(input, dependencies),
            type: "shell.output",
            durability: ordered(streamKey, nextSequence(streamSequences, streamKey)),
            payload: { invocationId: invocation.id, stream, chunk },
          }) as TransientRunEvent,
        ];
      }

      if (toolName === "write_stdin") {
        const processId = readProcessId(invocation.args);
        if (processId === undefined) return [];
        const streamKey = `process:${processId}`;
        return [
          ProcessOutputEventV2Schema.parse({
            ...base(input, dependencies),
            type: "process.output",
            durability: ordered(streamKey, nextSequence(streamSequences, streamKey)),
            payload: { processId, stream, chunk },
          }) as TransientRunEvent,
        ];
      }

      const streamKey = `tool:${invocation.id}`;
      return [
        ToolOutputEventV2Schema.parse({
          ...base(input, dependencies),
          type: "tool.output",
          durability: ordered(streamKey, nextSequence(streamSequences, streamKey)),
          payload: { invocationId: invocation.id, stream, chunk },
        }) as TransientRunEvent,
      ];
    });
  };

  return {
    project(input): TransientRunEvent | null {
      return projectMany(input)[0] ?? null;
    },
    projectMany,
  };
}

const MAX_RUNTIME_TRANSIENT_BYTES = 8 * 1024;

function splitTransientText(value: string): readonly string[] {
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  for (const character of value) {
    if (current.length > 0 && byteLength(`${current}${character}`) > MAX_RUNTIME_TRANSIENT_BYTES) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base(
  input: CodingRuntimeProgressEnvelope,
  dependencies: RuntimeProgressSignalProjectorDependencies,
) {
  return {
    eventId: dependencies.eventIdFactory.create(),
    schemaVersion: 2,
    runId: input.invocation.runId,
    sessionId: input.sessionId,
    stepId: input.invocation.stepId,
    timestamp: dependencies.clock.now(),
    visibility: "USER_VISIBLE" as const,
  };
}

function ordered(streamKey: string, streamSequence: number) {
  return {
    kind: "EPHEMERAL" as const,
    version: 1 as const,
    deliveryClass: "ORDERED" as const,
    streamKey,
    streamSequence,
  };
}

function nextSequence(sequences: Map<string, number>, streamKey: string): number {
  const next = (sequences.get(streamKey) ?? 0) + 1;
  sequences.set(streamKey, next);
  return next;
}

function readProcessId(args: Record<string, unknown>): string | undefined {
  const processId = args.session_id;
  return typeof processId === "string" && processId.length > 0 ? processId : undefined;
}
