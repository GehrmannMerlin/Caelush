import { InvalidSkillSearchCursorError } from "@caelush/skills";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import { SkillOperationError, type SkillOperations } from "../operations/skill-operations.js";
import { SEARCH_SKILLS_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { projectSearchSkillsSecurityFacts } from "../security/security-facts.js";
import { defineCodingTool } from "./define-coding-tool.js";
import {
  asOverlaySecurityFactsProjector,
  errorResult,
  positiveBoundedInteger,
  successResult,
  type AgentToolResult,
} from "./result.js";

const MAX_SEARCH_RESULTS = 100;
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_DESCRIPTION_CHARS = 128;

export const searchSkillsInputSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 256 },
    cursor: { type: "string", minLength: 1, maxLength: 2048 },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SEARCH_RESULTS,
      default: DEFAULT_SEARCH_RESULTS,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const searchSkillsOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    inventoryComplete: { type: "boolean" },
    nextCursor: { type: "string", maxLength: 2048 },
    items: {
      type: "array",
      maxItems: MAX_SEARCH_RESULTS,
      items: {
        type: "object",
        properties: {
          skillId: { type: "string", minLength: 1, maxLength: 256 },
          name: { type: "string", minLength: 1, maxLength: 64 },
          description: { type: "string", maxLength: MAX_DESCRIPTION_CHARS },
        },
        required: ["skillId", "name", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

export function createSearchSkillsTool(operations: SkillOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "search_skills",
    description: "Search Skills available for automatic use in this Run.",
    scheduling: { class: "READ_ONLY" },
    executionMode: "PARALLEL_SAFE",
    inputSchema: searchSkillsInputSchema,
    resultDetailsSchema: searchSkillsOutputSchema,
    execute: async (input): Promise<AgentToolResult> => {
      const args = input.args as { query?: unknown; cursor?: unknown; pageSize?: unknown };
      if (typeof args.query !== "string" || args.query.length === 0) {
        return errorResult("INVALID_QUERY", "Skill search query is invalid.");
      }
      if (args.cursor !== undefined && typeof args.cursor !== "string") {
        return errorResult("INVALID_CURSOR", "Skill search cursor is invalid.");
      }
      let pageSize: number;
      try {
        pageSize = positiveBoundedInteger(
          args.pageSize,
          DEFAULT_SEARCH_RESULTS,
          MAX_SEARCH_RESULTS,
        );
      } catch {
        return errorResult("INVALID_RANGE", "Skill search page size is invalid.");
      }

      try {
        const page = await operations.search({
          runId: input.identity.runId,
          query: args.query,
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          pageSize,
          signal: input.signal,
        });
        const items = page.items.map((item) => ({
          skillId: item.skillId,
          name: item.name,
          description: boundedDescription(item.description),
        }));
        const content =
          items.length === 0
            ? "No automatically available Skills matched this query."
            : items.map(({ name, description }) => `- ${name}: ${description}`).join("\n");
        return successResult(content, {
          inventoryComplete: page.inventoryComplete,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          items,
        });
      } catch (error) {
        if (error instanceof InvalidSkillSearchCursorError) {
          return errorResult("INVALID_CURSOR", "Skill search cursor is invalid for this query.");
        }
        if (error instanceof SkillOperationError) {
          return errorResult(error.code, error.message);
        }
        throw error;
      }
    },
  });

  return {
    tool,
    security: {
      riskLevel: "LOW",
      requiredCapabilities: [],
      runtimeRequirements: { runtimeKinds: [] },
    },
    securityFactsProjector: asOverlaySecurityFactsProjector(projectSearchSkillsSecurityFacts),
    promptSnippet: SEARCH_SKILLS_PROMPT_SNIPPET,
  };
}

function boundedDescription(description: string): string {
  const characters = Array.from(description);
  if (characters.length <= MAX_DESCRIPTION_CHARS) return description;
  return `${characters.slice(0, MAX_DESCRIPTION_CHARS - 1).join("")}…`;
}
