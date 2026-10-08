import { createHash } from "node:crypto";

export type RepresentativeScenarioId =
  | "SCENARIO_A_SIMPLE_LOGIN_EDIT"
  | "SCENARIO_B_MULTI_FILE_FEATURE"
  | "SCENARIO_C_LONG_TASK_RECOVERY";

export interface RepresentativeCodingScenarioManifest {
  readonly scenarioId: RepresentativeScenarioId;
  readonly scenarioVersion: 1;
  readonly fixtureFingerprint: string;
  readonly modelRef: { readonly providerId: "deepseek"; readonly modelId: "deepseek-reasoner" };
  readonly api: "openai-compatible-chat";
  readonly reasoningLevel: "HIGH";
  readonly cacheSettings: {
    readonly retention: "LONG";
    readonly key: "caelush-c5-representative-v1";
  };
  readonly expectedTaskType: string;
  readonly expectedFileChanges: readonly string[];
  readonly expectedVerification: readonly string[];
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxOutputTokens: number;
  readonly maxMissTokens: number;
  readonly maxEstimatedCostUsd: 0;
  readonly measurementPolicyVersion: "CACHE_METRICS_V2_C5_V1";
}

export const REPRESENTATIVE_REAL_PROVIDER_DISPATCH = "DISABLED" as const;
export const REPRESENTATIVE_METRIC_PROVENANCE = "SYNTHETIC" as const;
export const REPRESENTATIVE_COST_STATUS = "COST_UNVERIFIED" as const;

const MODEL_REF = Object.freeze({ providerId: "deepseek", modelId: "deepseek-reasoner" } as const);
const CACHE_SETTINGS = Object.freeze({
  retention: "LONG",
  key: "caelush-c5-representative-v1",
} as const);

const LOGIN_HTML_PREFIX = [
  "<!doctype html>",
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Sign in</title></head>',
  "<body>",
  '  <main class="login-shell">',
  '    <form class="login-form">',
  '      <label for="email">Email</label>',
  '      <input id="email" name="email" type="email" autocomplete="username">',
  '      <button class="login-button" type="submit">Sign in</button>',
  "    </form>",
  "  </main>",
  "</body>",
  "</html>",
  "",
].join("\n");

const SCENARIO_FILES: Readonly<Record<RepresentativeScenarioId, Readonly<Record<string, string>>>> =
  Object.freeze({
    SCENARIO_A_SIMPLE_LOGIN_EDIT: Object.freeze({
      "AGENTS.md":
        "Use semantic HTML, keep the login layout responsive, and verify the modified files before reporting success.\n",
      "README.md": "Login fixture. The form uses the local stylesheet and has no build step.\n",
      "src/login.html": LOGIN_HTML_PREFIX.padEnd(10_240, " "),
      "src/login.css": [
        ".login-shell { max-width: 28rem; margin: 3rem auto; }",
        ".login-button { background: #2852a6; color: white; }",
        "",
      ].join("\n"),
    }),
    SCENARIO_B_MULTI_FILE_FEATURE: Object.freeze({
      "AGENTS.md":
        "Keep browser behavior accessible, preserve ES modules, and verify every changed source file.\n",
      "README.md": "Small browser app fixture. The welcome action is wired in src/app.js.\n",
      "package.json": '{"name":"c5-browser-fixture","private":true,"type":"module"}\n',
      "src/index.html": [
        '<main><label for="name">Name</label><input id="name">',
        '<button id="welcome-button">Welcome</button><p id="welcome-output"></p></main>',
        '<script type="module" src="./app.js"></script>',
        "",
      ].join("\n"),
      "src/app.js": [
        'import { formatWelcome } from "./utils.js";',
        'const nameField = document.querySelector("#name");',
        'const output = document.querySelector("#welcome-output");',
        'document.querySelector("#welcome-button").addEventListener("click", () => {',
        "  output.textContent = formatWelcome(nameField.value);",
        "});",
        "",
      ].join("\n"),
      "src/styles.css": "#welcome-output { min-height: 1.5rem; }\n",
      "src/utils.js": [
        "export function formatWelcome(name) {",
        "  return `Hello, ${name}!`;",
        "}",
        "",
      ].join("\n"),
    }),
    SCENARIO_C_LONG_TASK_RECOVERY: Object.freeze({
      "AGENTS.md":
        "Inspect before editing. Keep the existing module API stable and verify changes after recovery.\n",
      "README.md": [
        "The `formatWelcome(name)` utility returns a greeting for a display name.",
        "Trim outer whitespace while preserving the existing function API.",
        "Use `friend` when the normalized name is empty.",
        "",
      ].join("\n"),
      "package.json": '{"name":"c5-recovery-fixture","private":true,"type":"module"}\n',
      "src/index.html": '<main><p id="welcome-output"></p></main>\n',
      "src/app.js": 'import { formatWelcome } from "./utils.js";\n',
      "src/styles.css": "#welcome-output { color: #213547; }\n",
      "src/utils.js": [
        "export function formatWelcome(name) {",
        "  // TODO: normalize empty and whitespace-only names.",
        "  return `Hello, ${name}!`;",
        "}",
        "",
      ].join("\n"),
    }),
  });

function fingerprintFixture(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(files[path] ?? "", "utf8");
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function manifest(input: {
  readonly scenarioId: RepresentativeScenarioId;
  readonly expectedTaskType: string;
  readonly expectedFileChanges: readonly string[];
  readonly expectedVerification: readonly string[];
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
}): RepresentativeCodingScenarioManifest {
  return Object.freeze({
    scenarioId: input.scenarioId,
    scenarioVersion: 1,
    fixtureFingerprint: fingerprintFixture(SCENARIO_FILES[input.scenarioId]),
    modelRef: MODEL_REF,
    api: "openai-compatible-chat",
    reasoningLevel: "HIGH",
    cacheSettings: CACHE_SETTINGS,
    expectedTaskType: input.expectedTaskType,
    expectedFileChanges: Object.freeze([...input.expectedFileChanges]),
    expectedVerification: Object.freeze([...input.expectedVerification]),
    maxModelCalls: input.maxModelCalls,
    maxToolCalls: input.maxToolCalls,
    maxOutputTokens: 8_192,
    maxMissTokens: 100_000,
    maxEstimatedCostUsd: 0,
    measurementPolicyVersion: "CACHE_METRICS_V2_C5_V1",
  });
}

export const representativeCodingScenarioManifests: readonly RepresentativeCodingScenarioManifest[] =
  Object.freeze([
    manifest({
      scenarioId: "SCENARIO_A_SIMPLE_LOGIN_EDIT",
      expectedTaskType: "SIMPLE_FILE_EDIT",
      expectedFileChanges: ["src/login.html", "src/login.css"],
      expectedVerification: ["updated login markup and focus styling"],
      maxModelCalls: 12,
      maxToolCalls: 8,
    }),
    manifest({
      scenarioId: "SCENARIO_B_MULTI_FILE_FEATURE",
      expectedTaskType: "MULTI_FILE_BROWSER_FEATURE",
      expectedFileChanges: ["src/app.js", "src/utils.js"],
      expectedVerification: ["node syntax checks", "Git status contains both edits"],
      maxModelCalls: 14,
      maxToolCalls: 10,
    }),
    manifest({
      scenarioId: "SCENARIO_C_LONG_TASK_RECOVERY",
      expectedTaskType: "LONG_TASK_RECOVERY_AND_CROSS_RUN",
      expectedFileChanges: ["src/utils.js"],
      expectedVerification: [
        "recovered edit preserves the API and blank-name behavior",
        "same-session history replay",
      ],
      maxModelCalls: 16,
      maxToolCalls: 10,
    }),
  ]);

export function representativeCodingFixtureFiles(
  scenarioId: RepresentativeScenarioId,
): Readonly<Record<string, string>> {
  return SCENARIO_FILES[scenarioId];
}

/** Hash only fixed, non-secret manifest fields; prompts and provider bodies are never retained. */
export function fingerprintRepresentativeScenario(
  value: RepresentativeCodingScenarioManifest,
): string {
  const canonical = JSON.stringify({
    scenarioId: value.scenarioId,
    scenarioVersion: value.scenarioVersion,
    fixtureFingerprint: value.fixtureFingerprint,
    modelRef: value.modelRef,
    api: value.api,
    reasoningLevel: value.reasoningLevel,
    cacheSettings: value.cacheSettings,
    expectedTaskType: value.expectedTaskType,
    expectedFileChanges: value.expectedFileChanges,
    expectedVerification: value.expectedVerification,
    maxModelCalls: value.maxModelCalls,
    maxToolCalls: value.maxToolCalls,
    maxOutputTokens: value.maxOutputTokens,
    maxMissTokens: value.maxMissTokens,
    maxEstimatedCostUsd: value.maxEstimatedCostUsd,
    measurementPolicyVersion: value.measurementPolicyVersion,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
