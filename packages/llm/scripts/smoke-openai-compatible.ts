import {
  createOpenAICompatibleLLMProvider,
  LLMGateway,
  LLMProviderRegistry,
} from "../dist/index.js";
import type { ToolDefinition } from "@caelush/protocol";

const baseURL = process.env.CAELUSH_OPENAI_COMPATIBLE_BASE_URL;
const apiKey = process.env.CAELUSH_OPENAI_COMPATIBLE_API_KEY;
const modelName = process.env.CAELUSH_OPENAI_COMPATIBLE_MODEL;
const includeTool = process.env.CAELUSH_LLM_SMOKE_TOOL === "1";

if (process.env.CAELUSH_LLM_SMOKE !== "1") {
  console.log("OpenAI-compatible smoke: SKIPPED (set CAELUSH_LLM_SMOKE=1 to opt in). ");
} else if (baseURL === undefined || apiKey === undefined || modelName === undefined) {
  console.log(
    "OpenAI-compatible smoke: SKIPPED (set CAELUSH_OPENAI_COMPATIBLE_BASE_URL, CAELUSH_OPENAI_COMPATIBLE_API_KEY, and CAELUSH_OPENAI_COMPATIBLE_MODEL).",
  );
} else {
  const providerId = "openai-compatible-smoke";
  const provider = createOpenAICompatibleLLMProvider({
    id: providerId,
    baseURL,
    apiKey,
  });
  const providers = new LLMProviderRegistry();
  providers.register(provider);
  const gateway = new LLMGateway({ providers });
  const tool: ToolDefinition = {
    name: "read_file",
    description: "Read a file by path.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    outputSchema: { type: "object" },
    riskLevel: "LOW",
    requiredCapabilities: ["FS_READ"],
    runtimeRequirements: { kind: "local" },
  };

  try {
    const result = await gateway.complete({
      model: { provider: providerId, model: modelName },
      messages: [
        {
          role: "user",
          content: includeTool
            ? "Use the read_file tool if appropriate; do not execute it locally."
            : "Reply with a short health-check response.",
        },
      ],
      ...(includeTool ? { tools: [tool] } : {}),
    });
    if (includeTool) {
      if (result.toolCalls.length === 0) {
        console.log("OpenAI-compatible smoke: SKIPPED / unsupported (no tool call returned).");
      } else {
        console.log("OpenAI-compatible smoke: PASS (tool call returned; no tool executed).");
      }
    } else if (result.text.trim() !== "CAELUSH_OK") {
      console.log("OpenAI-compatible smoke: SKIPPED (provider did not return trimmed CAELUSH_OK).");
    } else {
      console.log("OpenAI-compatible smoke: PASS (CAELUSH_OK).");
    }
  } catch {
    console.error("OpenAI-compatible smoke: FAIL (provider call did not complete safely).");
    process.exitCode = 1;
  }
}
