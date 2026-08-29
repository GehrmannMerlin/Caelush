import fastGlob from "fast-glob";
import { PROJECT_HARD_EXCLUDED_GLOBS } from "@caelush/shared";
import { RuntimeDiscoveryError } from "../runtime-errors.js";

export interface RuntimeFileDiscoveryRequest {
  readonly cwd: string;
  readonly pattern: string;
  readonly limit: number;
}

export interface RuntimeFileDiscoveryResult {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

export interface RuntimeFileDiscovery {
  find(request: RuntimeFileDiscoveryRequest): Promise<RuntimeFileDiscoveryResult>;
}

export class LocalRuntimeFileDiscovery implements RuntimeFileDiscovery {
  async find(request: RuntimeFileDiscoveryRequest): Promise<RuntimeFileDiscoveryResult> {
    try {
      const files = await fastGlob(request.pattern, {
        cwd: request.cwd,
        onlyFiles: true,
        followSymbolicLinks: false,
        unique: true,
        absolute: false,
        dot: true,
        ignore: PROJECT_HARD_EXCLUDED_GLOBS,
        suppressErrors: false,
        ...(request.limit < Number.MAX_SAFE_INTEGER ? { limit: request.limit + 1 } : {}),
      });
      const normalized = files
        .map((file) => file.replaceAll("\\", "/"))
        .sort((left, right) => left.localeCompare(right));
      return {
        files: normalized.slice(0, request.limit),
        truncated: normalized.length > request.limit,
      };
    } catch (error) {
      throw new RuntimeDiscoveryError("file pattern could not be evaluated", { cause: error });
    }
  }
}
