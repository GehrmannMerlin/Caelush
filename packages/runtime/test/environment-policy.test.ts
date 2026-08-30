import { describe, expect, it } from "vitest";
import { createAgentProcessEnvironment, createStructuredHelperEnvironment } from "../src/index.js";

describe("child process environment policy", () => {
  it("keeps compatible variables and removes credentials/injection variables", () => {
    const host = {
      PATH: "/usr/bin",
      HOME: "/home/test",
      USER: "test",
      LANG: "C.UTF-8",
      LC_ALL: "C",
      TERM: "xterm",
      OPENAI_API_KEY: "CAELUSH_HOST_SECRET_9D",
      GITHUB_TOKEN: "CAELUSH_HOST_GITHUB_9D",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      NODE_OPTIONS: "--require malicious.js",
      PYTHONPATH: "/tmp/inject",
      HTTPS_PROXY: "https://user:pass@example.invalid:443",
      RIPGREP_CONFIG_PATH: "/tmp/rg.conf",
    };

    const result = createAgentProcessEnvironment(host, "posix");

    expect(result).toMatchObject({ PATH: "/usr/bin", HOME: "/home/test", USER: "test" });
    expect(result).toHaveProperty("LANG", "C.UTF-8");
    expect(result).toHaveProperty("LC_ALL", "C");
    expect(result).toHaveProperty("TERM", "xterm");
    for (const key of [
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "HTTPS_PROXY",
      "RIPGREP_CONFIG_PATH",
    ]) {
      expect(result).not.toHaveProperty(key);
    }
    expect(host).toHaveProperty("OPENAI_API_KEY", "CAELUSH_HOST_SECRET_9D");
  });

  it("matches Windows environment names case-insensitively", () => {
    const result = createAgentProcessEnvironment(
      {
        Path: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        USERPROFILE: "C:\\Users\\test",
        openai_api_key: "CAELUSH_HOST_SECRET_9D",
        node_options: "--require malicious.js",
        ssh_auth_sock: "C:\\agent.sock",
      },
      "win32",
    );

    expect(result).toMatchObject({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\test",
    });
    expect(Object.keys(result).map((key) => key.toUpperCase())).not.toContain("OPENAI_API_KEY");
    expect(Object.keys(result).map((key) => key.toUpperCase())).not.toContain("NODE_OPTIONS");
    expect(Object.keys(result).map((key) => key.toUpperCase())).not.toContain("SSH_AUTH_SOCK");
  });

  it("uses an even smaller structured-helper environment and removes rg configuration", () => {
    const result = createStructuredHelperEnvironment(
      { PATH: "/usr/bin", HOME: "/home/test", LANG: "C", RIPGREP_CONFIG_PATH: "/tmp/rg.conf" },
      "posix",
    );

    expect(result).toMatchObject({ PATH: "/usr/bin", LANG: "C" });
    expect(result).not.toHaveProperty("RIPGREP_CONFIG_PATH");
    expect(result).not.toHaveProperty("HOME");
  });
});
