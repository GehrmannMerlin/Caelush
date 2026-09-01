import { SessionIdSchema, type SessionId } from "@caelush/protocol";

export type LaunchIntent =
  | { readonly kind: "NEW" }
  | { readonly kind: "CONTINUE" }
  | { readonly kind: "RESUME_PICKER" }
  | { readonly kind: "RESUME_EXACT"; readonly sessionId: SessionId };

export type PrintOutputFormat = "text" | "json" | "stream-json";

export type PrintIntent = {
  readonly kind: "PRINT";
  readonly prompt?: string;
  readonly outputFormat: PrintOutputFormat;
  readonly launchIntent: Exclude<LaunchIntent, { readonly kind: "RESUME_PICKER" }>;
};

export type CliCommand = LaunchIntent | PrintIntent;

export class CliArgsError extends Error {
  constructor(message = "Invalid Caelush command-line arguments.") {
    super(message);
    this.name = "CliArgsError";
  }
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { kind: "NEW" };

  let launchIntent: LaunchIntent = { kind: "NEW" };
  let launchIntentSet = false;
  let print = false;
  let prompt: string | undefined;
  let promptSet = false;
  let outputFormat: PrintOutputFormat = "text";
  let outputFormatSet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) throw new CliArgsError();
    if (token === "-c" || token === "--continue") {
      if (launchIntentSet) throw new CliArgsError();
      launchIntent = { kind: "CONTINUE" };
      launchIntentSet = true;
      continue;
    }
    if (token === "-r" || token === "--resume") {
      if (launchIntentSet) throw new CliArgsError();
      launchIntentSet = true;
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) {
        launchIntent = { kind: "RESUME_PICKER" };
        continue;
      }
      const sessionId = SessionIdSchema.safeParse(candidate);
      if (!sessionId.success) throw new CliArgsError();
      launchIntent = { kind: "RESUME_EXACT", sessionId: sessionId.data };
      index += 1;
      continue;
    }
    if (token === "-p" || token === "--print") {
      if (print) throw new CliArgsError();
      print = true;
      const candidate = argv[index + 1];
      if (candidate !== undefined && !candidate.startsWith("-")) {
        if (promptSet) throw new CliArgsError();
        prompt = candidate;
        promptSet = true;
        index += 1;
      }
      continue;
    }
    if (token === "--output-format") {
      if (outputFormatSet) throw new CliArgsError();
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) throw new CliArgsError();
      if (candidate !== "text" && candidate !== "json" && candidate !== "stream-json") {
        throw new CliArgsError();
      }
      outputFormat = candidate;
      outputFormatSet = true;
      index += 1;
      continue;
    }
    if (!token.startsWith("-") && print && !promptSet) {
      prompt = token;
      promptSet = true;
      continue;
    }
    throw new CliArgsError();
  }

  if (!print && outputFormatSet) throw new CliArgsError();
  if (print) {
    if (launchIntent.kind === "RESUME_PICKER") throw new CliArgsError();
    return {
      kind: "PRINT",
      ...(prompt === undefined ? {} : { prompt }),
      outputFormat,
      launchIntent,
    };
  }
  return launchIntent;
}
