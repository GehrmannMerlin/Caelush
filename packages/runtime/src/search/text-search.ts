export interface RuntimeTextSearchRequest {
  readonly signal?: AbortSignal;
  readonly cwd: string;
  readonly pattern: string;
  readonly include?: string;
  readonly limit: number;
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
