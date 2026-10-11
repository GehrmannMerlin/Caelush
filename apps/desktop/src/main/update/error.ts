export class DesktopUpdateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DesktopUpdateError";
  }
}
export function updateError(error: unknown): DesktopUpdateError {
  if (error instanceof DesktopUpdateError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("POLICY_")
  ) {
    return new DesktopUpdateError(error.code.slice(0, 64), error.message.slice(0, 512));
  }
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOSPC")
    return new DesktopUpdateError(
      "UPDATE_DISK_FULL",
      "There is not enough disk space for this update.",
    );
  return new DesktopUpdateError(
    "UPDATE_FAILED",
    "The update could not be completed safely. Retry when the problem is resolved.",
  );
}
