import { StorageDecodeError } from "./errors.js";

export interface ProtocolSchema<T> {
  parse(value: unknown): T;
}

export interface ProtocolCodecContext {
  readonly entityType: string;
  readonly entityId: string;
  readonly table: string;
}

export function encodeProtocol<T>(
  schema: ProtocolSchema<T>,
  value: T,
  context: ProtocolCodecContext,
): string {
  try {
    return JSON.stringify(schema.parse(value));
  } catch (error) {
    throw new StorageDecodeError(context.entityType, context.entityId, context.table, {
      cause: error,
    });
  }
}

export function decodeProtocol<T>(
  schema: ProtocolSchema<T>,
  json: string,
  context: ProtocolCodecContext,
): T {
  try {
    return schema.parse(JSON.parse(json) as unknown);
  } catch (error) {
    throw new StorageDecodeError(context.entityType, context.entityId, context.table, {
      cause: error,
    });
  }
}
