import { createPipeProcessAdapter } from "../exec/pipe-process-adapter.js";
import { createPtyProcessAdapter } from "../exec/pty-process-adapter.js";
import type { ProcessAdapterFactory } from "../exec/contracts.js";
import type { ProcessSandboxProvider, SandboxedSpawnSpec } from "./contracts.js";

export interface UnrestrictedProcessSandboxProviderOptions {
  readonly pipeFactory?: ProcessAdapterFactory;
  readonly ptyFactory?: ProcessAdapterFactory;
}

export function createUnrestrictedProcessSandboxProvider(
  options: UnrestrictedProcessSandboxProviderOptions = {},
): ProcessSandboxProvider {
  const pipeFactory = options.pipeFactory ?? { create: createPipeProcessAdapter };
  const ptyFactory = options.ptyFactory ?? { create: createPtyProcessAdapter };
  return Object.freeze({
    id: "unrestricted",
    kind: "UNRESTRICTED" as const,
    enforcement: "NONE" as const,
    create: (input: SandboxedSpawnSpec) =>
      (input.tty ? ptyFactory : pipeFactory).create({
        launch: input.launch,
        cwd: input.cwd,
        env: input.env,
        tty: input.tty,
      }),
  });
}
