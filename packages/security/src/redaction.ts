export {
  redactJson,
  redactText,
  secretDetector,
  secretRedactor,
  MAX_SECRET_JSON_DEPTH,
  MAX_SECRET_JSON_NODES,
  MAX_SECRET_SCAN_TEXT_BYTES,
} from "./secret-redaction.js";
export type {
  SecretCategory,
  SecretDetectionReport,
  SecretDetector,
  SecretRedactor,
} from "./secret-redaction.js";
