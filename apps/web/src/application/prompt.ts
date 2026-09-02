export const MAX_WEB_PROMPT_BYTES = 32 * 1024;
const MAX_PROMPT_TITLE_CODE_POINTS = 80;

export type PromptErrorCode = "PROMPT_REQUIRED" | "PROMPT_TOO_LARGE";

export interface PromptError {
  readonly code: PromptErrorCode;
  readonly message: string;
}

export type PromptValidationResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: PromptError };

export function validatePrompt(value: string): PromptValidationResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { code: "PROMPT_REQUIRED", message: "请输入任务内容。" } };
  }
  if (new TextEncoder().encode(trimmed).byteLength > MAX_WEB_PROMPT_BYTES) {
    return {
      ok: false,
      error: { code: "PROMPT_TOO_LARGE", message: "任务内容不能超过 32 KiB。" },
    };
  }
  return { ok: true, value: trimmed };
}

export function derivePromptTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return Array.from(firstLine).slice(0, MAX_PROMPT_TITLE_CODE_POINTS).join("") || "新会话";
}
