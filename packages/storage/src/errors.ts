export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(entityType: string, entityId: string) {
    super(`${entityType} ${entityId} was not found`);
    this.name = "StorageNotFoundError";
  }
}

export class StorageConflictError extends StorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageConflictError";
  }
}

export class StorageDecodeError extends StorageError {
  readonly entityType: string;
  readonly entityId: string;
  readonly table: string;

  constructor(entityType: string, entityId: string, table: string, options?: { cause?: unknown }) {
    super(`Unable to decode ${entityType} ${entityId} from ${table}`, options);
    this.name = "StorageDecodeError";
    this.entityType = entityType;
    this.entityId = entityId;
    this.table = table;
  }
}

export class StorageMigrationError extends StorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageMigrationError";
  }
}
