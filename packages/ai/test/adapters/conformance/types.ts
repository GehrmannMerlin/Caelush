import type { AISerializableError } from "../../../src/errors/serializable-error.js";
import type { ApiAdapter } from "../../../src/adapters/api-adapter.js";
import type { ApiId } from "../../../src/ids/api-id.js";
import type {
  CapturedHttpRequest,
  CapturingTransport,
} from "../../support/http-capturing-transport.js";
import type { CacheRetention } from "../../../src/cache/cache-retention.js";
import type { JsonObject } from "../../../src/json/json-value.js";
import type { ProviderCredentials } from "../../../src/providers/credentials.js";
import type { ReasoningLevel } from "../../../src/reasoning/reasoning-level.js";

/**
 * The shared adapter conformance contract.
 *
 * Nothing in this file is about a specific wire protocol. A dialect supplies its own
 * scripted traffic plus the two translation hooks below, and the same suite runs
 * unchanged for every registered `ApiAdapter`.
 */

/** The four finish reasons a dialect must map onto. */
export type FinishReasonInput = "STOP" | "LENGTH" | "TOOL_CALLS" | "CONTENT_FILTER";

/**
 * How a dialect proves a credential reached the transport.
 *
 * The suite asserts that the secret never reaches a public event for every dialect,
 * but *where* it is sent is dialect business: this hook lets a dialect state its own
 * native mechanism instead of the suite assuming a bearer token.
 */
export interface ConformanceCredentialAssertion {
  /** The header name the dialect authenticates with, lower-cased. */
  readonly header: string;
  /** The exact header value the dialect must send. */
  readonly value: string;
}

/**
 * The public event sequences a dialect produces for a fixed script.
 *
 * The conformance suite asserts an exact sequence because that is how envelope
 * authority, lifecycle completeness and ordering are proven. The *expected* sequence
 * is dialect data, not suite logic: a dialect that emits a usage snapshot per native
 * event legitimately has a different shape from one that emits it once.
 */
export interface ConformanceEventOrder {
  /** The public event sequence of the dialect's plain text turn. */
  readonly text: readonly string[];
  /** The public event sequence of the dialect's single-tool turn. */
  readonly toolLifecycle: readonly string[];
}

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
  readonly assertNative?: (request: CapturedHttpRequest) => void;
}

/** How a dialect expresses prompt-cache retention, if at all. */
export interface ConformanceCacheSupport {
  /** Whether the dialect can express SHORT or LONG at all. */
  readonly expressible: boolean;
  /** Assert the native provider request carries the translated option. */
  readonly assertNative?: (request: CapturedHttpRequest) => void;
}

/** The per-model shape the suite varies between scenarios. */
export interface ConformanceModelOverrides {
  readonly reasoningLevels?: readonly ReasoningLevel[];
  readonly cacheRetentions?: readonly CacheRetention[];
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
  /** How this dialect's native authentication is observable on the wire. */
  readonly credentialAssertion: ConformanceCredentialAssertion;
  /** The exact public event sequences this dialect produces for the suite's scripts. */
  readonly eventOrder: ConformanceEventOrder;

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

  /**
   * The per-model `adapterMetadata` this dialect needs for the suite's descriptors.
   *
   * A dialect that declares its capabilities through the frozen model-descriptor
   * contract supplies the data here; the suite never interprets it. A dialect whose
   * models need no metadata omits the hook.
   */
  readonly modelMetadata?: (overrides: ConformanceModelOverrides) => JsonObject;
}

/** The public event sequence of one conformance run. */
export interface ConformanceRun {
  readonly eventTypes: readonly string[];
  readonly events: readonly { readonly type: string; readonly payload: unknown }[];
  /** The terminal `stream.error` payload, when the run failed. */
  readonly streamError: AISerializableError | undefined;
  /** The failure thrown by preflight, when the run never produced a stream. */
  readonly thrown: unknown;
  /** The captured provider requests, in dialect-neutral terms. */
  readonly requests: readonly CapturedHttpRequest[];
  /** How many transport attempts were made. */
  readonly transportAttempts: number;
}
