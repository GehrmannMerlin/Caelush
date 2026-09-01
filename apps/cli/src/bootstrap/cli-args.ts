import { SessionIdSchema, type SessionId } from "@caelush/protocol";

export type LaunchIntent =
  | { readonly kind: "NEW" }
  | { readonly kind: "CONTINUE" }
  | { readonly kind: "RESUME_PICKER" }
  | { readonly kind: "RESUME_EXACT"; readonly sessionId: SessionId };

export class CliArgsError extends Error {
  constructor(message = "Invalid Caelush command-line arguments.") {
    super(message);
    this.name = "CliArgsError";
  }
}

export function parseCliArgs(argv: readonly string[]): LaunchIntent {
  if (argv.length === 0) return { kind: "NEW" };

  const [flag, value, ...extra] = argv;
  if (flag === "-c" || flag === "--continue") {
    if (value !== undefined || extra.length > 0) throw new CliArgsError();
    return { kind: "CONTINUE" };
  }
  if (flag === "-r" || flag === "--resume") {
    if (extra.length > 0) throw new CliArgsError();
    if (value === undefined) return { kind: "RESUME_PICKER" };
    const sessionId = SessionIdSchema.safeParse(value);
    if (!sessionId.success) throw new CliArgsError();
    return { kind: "RESUME_EXACT", sessionId: sessionId.data };
  }
  throw new CliArgsError();
}
