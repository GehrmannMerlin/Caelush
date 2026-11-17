import type { BoundedSkillResource } from "@caelush/skills";

import type { CodingToolDefinition } from "../coding-tool-definition.js";
import type { SkillOperations } from "../operations/skill-operations.js";
import { SkillOperationError } from "../operations/skill-operations.js";
import { READ_SKILL_PROMPT_SNIPPET } from "../prompt/prompt-snippets.js";
import { projectReadSkillSecurityFacts } from "../security/security-facts.js";
import { defineCodingTool } from "./define-coding-tool.js";
import { asOverlaySecurityFactsProjector, errorResult, successResult } from "./result.js";

export const MAX_SKILL_SUPPLEMENTAL_TEXT_BYTES = 16 * 1024;

export const readSkillInputSchema = {
  type: "object",
  properties: {
    skillId: { type: "string", minLength: 1, maxLength: 256 },
    resourcePath: { type: "string", minLength: 1, maxLength: 1024 },
    cursor: { type: "string", minLength: 1, maxLength: 512 },
  },
  required: ["skillId"],
  additionalProperties: false,
} as const;

const readSkillOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
    state: { type: "string", enum: ["CONTENT_READY", "RESOURCE_READ"] },
    resourcePath: { type: "string", maxLength: 1024 },
    resourceKind: { type: "string", enum: ["TEXT", "BYTES", "ARTIFACT"] },
    complete: { type: "boolean" },
    bytesReturned: { type: "integer", minimum: 0 },
    nextCursor: { type: "string", maxLength: 512 },
  },
  required: ["ok"],
  additionalProperties: false,
} as const;

const CONTENT_READY_MARKER = "Skill content is ready for Context preparation.";

export function createReadSkillTool(operations: SkillOperations): CodingToolDefinition {
  const tool = defineCodingTool({
    name: "read_skill",
    description:
      "Read a complete Skill core for later Context preparation, or a bounded supplemental resource.",
    scheduling: { class: "READ_ONLY" },
    executionMode: "SEQUENTIAL",
    settlementOutputCapabilities: Object.freeze(["WORKFLOW_RESOURCE_BINDING"] as const),
    inputSchema: readSkillInputSchema,
    resultDetailsSchema: readSkillOutputSchema,
    execute: async (input) => {
      const args = input.args as {
        skillId?: unknown;
        resourcePath?: unknown;
        cursor?: unknown;
      };
      if (typeof args.skillId !== "string" || args.skillId.length === 0) {
        return errorResult("INVALID_SKILL_ID", "Skill identity is invalid.");
      }
      if (args.resourcePath !== undefined && typeof args.resourcePath !== "string") {
        return errorResult("SKILL_RESOURCE_DENIED", "Skill resource path is invalid.");
      }
      if (args.cursor !== undefined && typeof args.cursor !== "string") {
        return errorResult("SKILL_RESOURCE_INVALID", "Skill resource cursor is invalid.");
      }
      if (args.resourcePath === undefined && args.cursor !== undefined) {
        return errorResult("SKILL_CORE_INVALID", "The complete Skill core cannot be paged.");
      }

      try {
        const result = await operations.read({
          runId: input.identity.runId,
          invocationId: input.identity.invocationId,
          skillId: args.skillId,
          ...(args.resourcePath === undefined ? {} : { resourcePath: args.resourcePath }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          signal: input.signal,
        });
        if (result.kind === "CORE_CONTENT_READY") {
          if (args.resourcePath !== undefined) {
            return errorResult(
              "SKILL_RESOURCE_INVALID",
              "A supplemental resource read cannot create a Skill core binding.",
            );
          }
          return Object.freeze({
            result: successResult(CONTENT_READY_MARKER, { state: "CONTENT_READY" }),
            preparedResourceBindings: Object.freeze([result.bindingDraft]),
          });
        }
        return supplementalResult(result.resource, result.nextCursor);
      } catch (error) {
        if (error instanceof SkillOperationError) return errorResult(error.code, error.message);
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
    securityFactsProjector: asOverlaySecurityFactsProjector(projectReadSkillSecurityFacts),
    promptSnippet: READ_SKILL_PROMPT_SNIPPET,
  };
}

function supplementalResult(resource: BoundedSkillResource, nextCursor?: string) {
  if (resource.kind !== "TEXT" || !resource.complete) {
    return errorResult(
      "SKILL_RESOURCE_INVALID",
      "The supplemental Skill resource is not complete text.",
    );
  }
  if (Buffer.byteLength(resource.text, "utf8") > MAX_SKILL_SUPPLEMENTAL_TEXT_BYTES) {
    return errorResult(
      "SKILL_RESOURCE_INVALID",
      "The supplemental Skill resource exceeds its read budget.",
    );
  }
  return successResult(resource.text, {
    state: "RESOURCE_READ",
    resourcePath: resource.relativePath,
    resourceKind: resource.kind,
    complete: resource.complete,
    bytesReturned: Buffer.byteLength(resource.text, "utf8"),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}
