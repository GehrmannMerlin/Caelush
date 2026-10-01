export interface RuntimeTextSearchRequest {
  readonly signal?: AbortSignal;
  readonly cwd: string;
  readonly pattern: string;
  readonly include?: string;
  readonly limit: number;
  /** Force the in-process fallback when a direct helper process has not been authorized. */
  readonly requireProcessBoundary?: boolean;
  /** Resolve each candidate immediately before it is opened. */
  readonly resolveTarget?: (
    absolutePath: string,
  ) => Promise<{ readonly canonicalPath: string; readonly kind: string }>;
}

export interface RuntimeTextSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface RuntimeTextSearchResult {
  readonly matches: readonly RuntimeTextSearchMatch[];
  readonly truncated: boolean;
}

export interface RuntimeTextSearch {
  search(request: RuntimeTextSearchRequest): Promise<RuntimeTextSearchResult>;
}
