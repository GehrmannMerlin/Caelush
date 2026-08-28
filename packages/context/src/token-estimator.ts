export interface TokenEstimator {
  estimateText(text: string): number;
}

export class Utf8HeuristicTokenEstimator implements TokenEstimator {
  estimateText(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
  }
}
