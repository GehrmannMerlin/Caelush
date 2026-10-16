import type { CaelushClient } from "@caelush/client";
import { createTimestampMs } from "@caelush/protocol";
import type { SessionArchiveStore } from "./session-archive-store.js";
const flights = new WeakMap<
  SessionArchiveStore,
  WeakMap<object, Promise<{ imported: number; deferred: number }>>
>();
export function importLegacySessionArchives(input: {
  client: Pick<CaelushClient, "importLegacyArchives">;
  store: SessionArchiveStore;
  signal?: AbortSignal;
}): Promise<{ imported: number; deferred: number }> {
  let clients = flights.get(input.store);
  if (clients === undefined) {
    clients = new WeakMap();
    flights.set(input.store, clients);
  }
  const previous = clients.get(input.client);
  if (previous !== undefined) return previous;
  const run = async () => {
    const markers = input.store.list();
    let imported = 0;
    for (let offset = 0; offset < markers.length; offset += 100) {
      input.signal?.throwIfAborted();
      const batch = markers.slice(offset, offset + 100);
      const ids = new Set(batch.map((m) => m.sessionId));
      const result = await input.client.importLegacyArchives(
        {
          markers: batch.map((m) => ({
            sessionId: m.sessionId,
            archivedAt: createTimestampMs(m.archivedAt),
          })),
        },
        input.signal === undefined ? {} : { signal: input.signal },
      );
      const applied = [
        ...new Set([...result.importedSessionIds, ...result.alreadyArchivedSessionIds]),
      ].filter((id) => ids.has(id));
      input.store.acknowledge(applied);
      imported += applied.length;
    }
    return { imported, deferred: input.store.list().length };
  };
  const promise = run();
  clients.set(input.client, promise);
  void promise
    .finally(() => {
      if (clients.get(input.client) === promise) clients.delete(input.client);
    })
    .catch(() => undefined);
  return promise;
}
