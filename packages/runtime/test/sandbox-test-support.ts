import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TemporarySandboxWorkspace {
  readonly root: string;
  readonly outside: string;
  cleanup(): Promise<void>;
}

export async function createTemporarySandboxWorkspace(
  prefix = "caelush-sandbox-fixture-",
): Promise<TemporarySandboxWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const outside = await mkdtemp(path.join(os.tmpdir(), `${prefix}outside-`));
  return {
    root,
    outside,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}
