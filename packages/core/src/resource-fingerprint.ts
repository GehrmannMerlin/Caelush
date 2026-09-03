import { createHash } from "node:crypto";
import { canonicalJsonString } from "@caelush/tools";
import type { JsonObject, JsonValue } from "@caelush/protocol";

export function fingerprintToolRequest(toolName: string, args: JsonObject): string {
  return fingerprint({ kind: "request", toolName, value: args });
}

export function fingerprintToolResult(result: JsonValue): string {
  return fingerprint({ kind: "result", value: result });
}

export function fingerprintToolBatch(
  requests: readonly { readonly toolName: string; readonly args: JsonObject }[],
): string {
  return fingerprint({
    kind: "request-batch",
    value: requests.map((request) => ({ toolName: request.toolName, args: request.args })),
  });
}

export function fingerprintToolResultBatch(
  results: readonly { readonly content: string; readonly isError: boolean }[],
): string {
  return fingerprint({ kind: "result-batch", value: results.map((result) => ({ ...result })) });
}

function fingerprint(value: JsonValue): string {
  return `v1:${createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex")}`;
}
