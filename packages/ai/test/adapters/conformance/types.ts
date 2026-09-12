import type { AISerializableError } from "../../../src/errors/serializable-error.js";
import type { ApiAdapter } from "../../../src/adapters/api-adapter.js";
import type { ApiId } from "../../../src/ids/api-id.js";
import type {
  CapturedRequest,
  CapturingTransport,
} from "../../support/openai-compatible-transport.js";
import type { ProviderCredentials } from "../../../src/providers/credentials.js";
import type { ReasoningLevel } from "../../../src/reasoning/reasoning-level.js";

/** The four finish reasons a dialect must map onto. */
export type FinishReasonInput = "STOP" | "LENGTH" | "TOOL_CALLS" | "CONTENT_FILTER";

/** How a dialect expresses reasoning levels, if at all. */
export interface ConformanceReasoningSupport {
  /** The level the suite requests; the model descriptor must support it. */
  readonly level: ReasoningLevel;
  /**
   * Assert the native provider request carries the translated option.
   *
   * Omit it when the dialect cannot express the level: the suite then requires the
   * request to fail closed with `AI_CAPABILITY_UNSUPPORTED` rather than silently drop it.
   */
  readonly assertNative?: (request: CapturedRequest) => void;
}

/** How a dialect expresses prompt-cache retention, if at all. */
export interface ConformanceCacheSupport {
  /** Whether the dialect can express SHORT or LONG at all. */
  readonly expressible: boolean;
  /** Assert the native provider request carries the translated option. */
  readonly assertNative?: (request: CapturedRequest) => void;
}

/**
 * Everything a dialect must supply to run the reusable adapter conformance suite.
 *
 * Every script returns a controlled local transport: a conformance run never touches a
 * real provider endpoint. The dialect supplies its own wire traffic, so a second
 * dialect reuses the whole suite unchanged.
 */
export interface AdapterConformanceOptions {
  readonly apiId: ApiId;
  readonly providerId: string;
  readonly endpoint: string;
  readonly adapters: readonly ApiAdapter[];
  /** Credentials sent on every scenario, used to prove they never reach an event. */
  readonly credentials: ProviderCredentials;
  /** The credential value that must never appear in a public event. */
  readonly secret: string;

  readonly textTurn: (text: string) => CapturingTransport;
  readonly toolTurn: () => CapturingTransport;
  readonly parallelToolTurn: () => CapturingTransport;
  readonly usageTurn: () => CapturingTransport;
  readonly finishReason: (reason: FinishReasonInput) => CapturingTransport;
  readonly unknownFinish: () => CapturingTransport;

  readonly authFailure: () => CapturingTransport;
  readonly rateLimitFailure: () => CapturingTransport;
  readonly overflowFailure: () => CapturingTransport;
  readonly invalidResponseFailure: () => CapturingTransport;
  readonly networkFailure: () => CapturingTransport;
  readonly textThenFailure: () => CapturingTransport;

  /** A transport that never completes until the request signal aborts. */
  readonly hang: () => CapturingTransport & { readonly observedAbort: () => boolean };

  readonly reasoning: ConformanceReasoningSupport;
  readonly cache: ConformanceCacheSupport;
}

/** The public event sequence of one conformance run. */
export interface ConformanceRun {
  readonly eventTypes: readonly string[];
  readonly events: readonly { readonly type: string; readonly payload: unknown }[];
  /** The terminal `stream.error` payload, when the run failed. */
  readonly streamError: AISerializableError | undefined;
  /** The failure thrown by preflight, when the run never produced a stream. */
  readonly thrown: unknown;
  /** The captured provider requests. */
  readonly requests: readonly CapturedRequest[];
  /** How many transport attempts were made. */
  readonly transportAttempts: number;
}
