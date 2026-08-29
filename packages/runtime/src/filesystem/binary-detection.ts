import path from "node:path";

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".class",
  ".dll",
  ".dylib",
  ".exe",
  ".gif",
  ".gz",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".tgz",
  ".wav",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

export function isBinarySample(filePath: string, sample: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
  if (sample.byteLength === 0) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / sample.byteLength > 0.3;
}
