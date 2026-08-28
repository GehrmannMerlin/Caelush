import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  StorageConflictError,
  StorageDecodeError,
  StorageError,
  StorageNotFoundError,
} from "@caelush/storage";
import type { ApiErrorCode, ApiErrorResponse } from "@caelush/protocol";
import { LocalRequestRejectedError } from "./local-request-guard.js";

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

function isValidationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "validation" in error;
}

function mapError(error: unknown): MappedError {
  if (error instanceof LocalRequestRejectedError) {
    return { statusCode: 403, code: "INVALID_REQUEST", message: "Request is not allowed." };
  }
  if (error instanceof InvalidEventCursorError) {
    return { statusCode: 400, code: "INVALID_EVENT_CURSOR", message: "The event cursor is invalid." };
  }
  if (isValidationError(error)) {
    return { statusCode: 400, code: "INVALID_REQUEST", message: "The request is invalid." };
  }
  if (error instanceof StorageNotFoundError) {
    return { statusCode: 404, code: "NOT_FOUND", message: "Requested resource was not found." };
  }
  if (error instanceof StorageConflictError) {
    return { statusCode: 409, code: "CONFLICT", message: "The request conflicts with stored data." };
  }
  if (error instanceof StorageDecodeError || error instanceof StorageError) {
    return { statusCode: 500, code: "STORAGE_ERROR", message: "Stored data could not be read." };
  }
  return { statusCode: 500, code: "INTERNAL_ERROR", message: "An internal error occurred." };
}

export function toApiErrorResponse(error: unknown, requestId: string): {
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
