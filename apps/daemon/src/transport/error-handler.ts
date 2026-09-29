import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "@caelush/storage";
import type { ApiErrorCode, ApiErrorResponse } from "@caelush/protocol";
import {
  RunControllerBusyError,
  RunControllerConflictError,
  RunControllerInfrastructureError,
  RunControllerInputError,
} from "@caelush/core";
import { LocalRequestRejectedError } from "./local-request-guard.js";
import {
  RunExecutionSupervisorBusyError,
  RunExecutionSupervisorConflictError,
  RunExecutionSupervisorInfrastructureError,
} from "../execution/run-execution-supervisor.js";
import { DaemonModelConfigurationError } from "../providers/model-canonicalizer.js";
import { EventCursorAheadError } from "../events/run-event-hub.js";
import { WorkspacePathError } from "../workspaces/workspace-identity.js";
import { ActiveRunConflictError, WorkspaceOwnershipError } from "../workspaces/workspace-errors.js";

export class InvalidEventCursorError extends Error {
  constructor() {
    super("The event cursor is invalid.");
    this.name = "InvalidEventCursorError";
  }
}

interface MappedError {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidationError(error: unknown): boolean {
  return isRecord(error) && "validation" in error;
}

/**
 * A client-error status the HTTP framework itself already decided.
 *
 * Fastify's own request-parsing failures — an empty body sent as `application/json`, an unsupported
 * media type, an oversized payload — are ordinary `Error`s that carry no `validation` array and no
 * product error class, but they do carry their own `statusCode`. Before this they fell through every
 * branch to the final anonymous `500 INTERNAL_ERROR`, which is the single answer an operator cannot act
 * on and a client cannot correct: the request was malformed, and the server reported it as its own
 * fault.
 *
 * Only a 4xx is claimed here. A framework failure that is genuinely the server's (a serializer fault, a
 * 5xx) must keep falling through to the same explicit 500 branches as any other unexpected error, so
 * this rule can never mask a real server-side defect.
 */
const CLIENT_ERROR_STATUS_MIN = 400;
const CLIENT_ERROR_STATUS_MAX = 499;

function clientErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const statusCode = error.statusCode;
  if (typeof statusCode !== "number" || !Number.isInteger(statusCode)) return undefined;
  if (statusCode < CLIENT_ERROR_STATUS_MIN || statusCode > CLIENT_ERROR_STATUS_MAX) return undefined;
  return statusCode;
}

function isEventCursorValidationError(error: unknown): boolean {
  if (
    !isRecord(error) ||
    error.validationContext !== "querystring" ||
    !Array.isArray(error.validation)
  ) {
    return false;
  }
  return (
    error.validation.length > 0 &&
    error.validation.every((issue) => isRecord(issue) && issue.instancePath === "/afterSequence")
  );
}

function mapError(error: unknown): MappedError {
  if (error instanceof WorkspacePathError) {
    return {
      statusCode: 400,
      code: "INVALID_REQUEST",
      message: "The workspace path is invalid.",
    };
  }
  if (error instanceof WorkspaceOwnershipError) {
    return { statusCode: 400, code: "INVALID_REQUEST", message: "The Workspace ownership is invalid." };
  }
  if (error instanceof ActiveRunConflictError) {
    return {
      statusCode: 409,
      code: "ACTIVE_RUN_CONFLICT",
      message: "The Workspace has an active Run and cannot be forgotten.",
    };
  }
  if (error instanceof LocalRequestRejectedError) {
    return { statusCode: 403, code: "INVALID_REQUEST", message: "Request is not allowed." };
  }
  if (error instanceof InvalidEventCursorError) {
    return {
      statusCode: 400,
      code: "INVALID_EVENT_CURSOR",
      message: "The event cursor is invalid.",
    };
  }
  if (error instanceof EventCursorAheadError) {
    return {
      statusCode: 409,
      code: "EVENT_CURSOR_AHEAD",
      message: "The event cursor is ahead of the committed Run history.",
    };
  }
  if (isEventCursorValidationError(error)) {
    return {
      statusCode: 400,
      code: "INVALID_EVENT_CURSOR",
      message: "The event cursor is invalid.",
    };
  }
  if (isValidationError(error)) {
    return { statusCode: 400, code: "INVALID_REQUEST", message: "The request is invalid." };
  }
  if (error instanceof StorageNotFoundError) {
    return { statusCode: 404, code: "NOT_FOUND", message: "Requested resource was not found." };
  }
  if (error instanceof StorageConflictError) {
    return {
      statusCode: 409,
      code: "CONFLICT",
      message: "The request conflicts with stored data.",
    };
  }
  if (error instanceof DaemonModelConfigurationError) {
    return {
      statusCode: 409,
      code: "MODEL_PROVIDER_UNAVAILABLE",
      message: "The requested model provider or model is unavailable.",
    };
  }
  if (
    error instanceof RunControllerBusyError ||
    error instanceof RunControllerConflictError ||
    error instanceof RunControllerInputError ||
    error instanceof RunExecutionSupervisorBusyError ||
    error instanceof RunExecutionSupervisorConflictError
  ) {
    return { statusCode: 409, code: "CONFLICT", message: "The request conflicts with Run state." };
  }
  if (
    error instanceof RunControllerInfrastructureError ||
    error instanceof RunExecutionSupervisorInfrastructureError
  ) {
    return {
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Run execution could not be started.",
    };
  }
  if (error instanceof StorageDecodeError || error instanceof StorageError) {
    return { statusCode: 500, code: "STORAGE_ERROR", message: "Stored data could not be read." };
  }
  // A malformed request the framework already classified as a client error is reported with the
  // surface's one code for bad input, and never with the framework's own message: a parser message can
  // quote the offending body, and the error surface must not echo request content back.
  if (clientErrorStatus(error) !== undefined) {
    return { statusCode: 400, code: "INVALID_REQUEST", message: "The request is invalid." };
  }
  return { statusCode: 500, code: "INTERNAL_ERROR", message: "An internal error occurred." };
}

export function toApiErrorResponse(
  error: unknown,
  requestId: string,
): {
  readonly statusCode: number;
  readonly body: ApiErrorResponse;
} {
  const mapped = mapError(error);
  return {
    statusCode: mapped.statusCode,
    body: {
      error: { code: mapped.code, message: mapped.message, requestId },
    },
  };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = toApiErrorResponse(error, request.id);
    void reply.code(mapped.statusCode).send(mapped.body);
  });
  app.setNotFoundHandler((request, reply) => {
    const mapped = toApiErrorResponse(new StorageNotFoundError("Route", request.url), request.id);
    void reply.code(mapped.statusCode).send(mapped.body);
  });
}
