export type RuntimeFileKind = "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER" | "MISSING";

export interface RuntimeFileMetadata {
  readonly kind: RuntimeFileKind;
  readonly sizeBytes?: number;
}

export interface RuntimeFileFingerprint {
  readonly kind: RuntimeFileKind;
  readonly sizeBytes?: number;
  readonly sha256?: string;
}

export interface RuntimeDirectoryEntry {
  readonly name: string;
  readonly kind: RuntimeFileKind;
}

export interface RuntimeTextRead {
  readonly lines: readonly string[];
  readonly lineStart: number;
  readonly bytesReturned: number;
  readonly truncated: boolean;
  readonly nextOffset?: number;
  readonly utf8Bom: boolean;
}

export interface RuntimeFileSystem {
  getMetadata(absolutePath: string): Promise<RuntimeFileMetadata | null>;
  fingerprint(absolutePath: string): Promise<RuntimeFileFingerprint>;
  realpath(absolutePath: string): Promise<string>;
  readDirectory(absolutePath: string): Promise<readonly RuntimeDirectoryEntry[]>;
  readTextFile(
    absolutePath: string,
    options: { readonly offset: number; readonly limit: number; readonly maxBytes: number },
  ): Promise<RuntimeTextRead>;
}
