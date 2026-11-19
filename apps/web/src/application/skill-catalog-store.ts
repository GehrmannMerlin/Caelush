import type { CaelushClient, CaelushClientRequestOptions } from "@caelush/client";
import type {
  SkillCatalogPageV1,
  SkillCatalogQuery,
  SkillCapabilityResponse,
  WorkspaceId,
} from "@caelush/protocol";

export interface SkillCatalogListRequest {
  readonly workspaceId: WorkspaceId;
  readonly query: string;
  readonly cursor?: string | undefined;
  readonly signal: AbortSignal;
}

export type SkillCatalogListSkills = (
  input: SkillCatalogListRequest,
) => Promise<SkillCatalogPageV1>;

export interface SkillCatalogStore {
  getCapabilities(options?: CaelushClientRequestOptions): Promise<SkillCapabilityResponse | null>;
  listSkills: SkillCatalogListSkills;
}

export type SkillCatalogStoreClient = Pick<CaelushClient, "getSkillCapabilities" | "listSkills">;

export function createSkillCatalogStore(client: SkillCatalogStoreClient): SkillCatalogStore {
  return {
    getCapabilities: (options) => client.getSkillCapabilities(options),
    listSkills: ({ workspaceId, query, cursor, signal }) => {
      const catalogQuery: Partial<SkillCatalogQuery> = {
        q: query,
        ...(cursor === undefined ? {} : { cursor }),
      };
      return client.listSkills(workspaceId, catalogQuery, { signal });
    },
  };
}
