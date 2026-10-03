import { describe, expect, it } from "vitest";

type StartDevelopmentDaemon = (options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly prepare: () => Promise<{
    readonly status: "CONFIGURED";
    readonly environment: Readonly<Record<string, string | undefined>>;
  }>;
  readonly start: (environment: Readonly<Record<string, string | undefined>>) => Promise<string>;
  readonly writeWarning: (text: string) => void;
}) => Promise<string>;

async function developmentStarter(): Promise<StartDevelopmentDaemon> {
  const entryUrl = new URL("./start-daemon-dev.mjs", import.meta.url).href;
  const module = (await import(entryUrl)) as {
    readonly startDevelopmentDaemon?: StartDevelopmentDaemon;
  };
  expect(module.startDevelopmentDaemon).toBeTypeOf("function");
  return module.startDevelopmentDaemon!;
}

describe("development daemon entry", () => {
  it("starts the daemon with the automatically prepared Runner environment", async () => {
    const startDevelopmentDaemon = await developmentStarter();
    const warnings: string[] = [];
    const result = await startDevelopmentDaemon({
      environment: { CAELUSH_HOME: "C:/caelush-home" },
      prepare: async () => ({
        status: "CONFIGURED",
        environment: {
          CAELUSH_HOME: "C:/caelush-home",
          CAELUSH_SANDBOX_RUNNER_PATH: "C:/runner/caelush-sandbox-runner.exe",
          CAELUSH_SANDBOX_RUNNER_MANIFEST: "C:/runner/manifest.json",
        },
      }),
      start: async (environment) =>
        `${environment.CAELUSH_SANDBOX_RUNNER_PATH}|${environment.CAELUSH_SANDBOX_RUNNER_MANIFEST}`,
      writeWarning: (text) => warnings.push(text),
    });

    expect(result).toBe("C:/runner/caelush-sandbox-runner.exe|C:/runner/manifest.json");
    expect(warnings).toEqual([]);
  });
});
