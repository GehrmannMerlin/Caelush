import type { AIMessage } from "@caelush/ai";
import type { RunId } from "@caelush/protocol";

import type { CaelushStorage } from "../../src/index.js";
import { testRunMessageAuthority } from "../../../core/test/support/run-message-authority.js";

/** Test-only compatibility projection for assertions that inspect the model-facing history. */
export async function projectedRunMessages(
  storage: CaelushStorage,
  runId: RunId,
): Promise<readonly AIMessage[]> {
  const messages = testRunMessageAuthority();
  const records = await storage.messageRecords.listByRun(runId);
  return records.flatMap(
    (record) =>
      messages.projectors.project({
        sequence: record.sequence,
        schemaVersion: record.schemaVersion,
        ...(record.modelProjectionVersion === undefined
          ? {}
          : { modelProjectionVersion: record.modelProjectionVersion }),
        message: messages.codecs.decode(record),
      }).messages,
  );
}
