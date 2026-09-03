import { createHash } from "node:crypto";
import { canonicalJsonString } from "@caelush/tools";
import type { JsonObject, JsonValue } from "@caelush/protocol";

export function fingerprintToolRequest(toolName: string, args: JsonObject): string {
  return fingerprint({ kind: "request", toolName, value: args });
}

export function fingerprintToolResult(result: JsonValue): string {
  return fingerprint({ kind: "result", value: result });
}

function fingerprint(value: JsonValue): string {
  return `v1:${createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex")}`;
}
