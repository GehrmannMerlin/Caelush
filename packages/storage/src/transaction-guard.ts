import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { StorageError } from "./errors.js";

/**
 * One authoritative transaction at a time, per SQLite connection.
 *
 * ```text
 * BEGIN IMMEDIATE ... await ... COMMIT
 * ```
 *
 * The database handle is synchronous, but an authoritative transaction body is not: it reads
 * through the repository layer, and every read is an `await`. Between two of those awaits the event
 * loop can run another request on the *same* connection, and a second `BEGIN IMMEDIATE` then fails
 * with "cannot start a transaction within a transaction" — or, on a driver that tolerated nesting,
 * commits half of one transition inside another.
 *
 * The guard serializes entries into those transactions. It deliberately does **not** wrap reads, and
 * it is not a Run lock: two different Runs may be admitted back to back, and nothing waits on a
 * provider, a Tool or a Hook while it holds the queue.
 *
 * The queue is per connection, so two databases (a test's temporary database and a production one)
 * never wait on each other. Re-entry from inside a guarded body — a commit that calls another
 * guarded operation — is recognised structurally rather than by a flag, so an unrelated concurrent
 * caller can never be mistaken for the current holder.
 */

const holders = new AsyncLocalStorage<DatabaseSync>();
const tails = new WeakMap<DatabaseSync, Promise<void>>();

/** Run one authoritative transaction body with exclusive access to its connection. */
export async function withAuthoritativeTransaction<T>(
  client: DatabaseSync,
  work: () => Promise<T>,
): Promise<T> {
  if (holders.getStore() === client) {
    // Already inside this connection's guarded transaction: one logical transaction, no second
    // BEGIN, and no waiting on ourselves.
    return work();
  }
  if (client.isTransaction) {
    // An unguarded transaction already owns the connection. A guarded operation cannot tell whether
    // it may join it, so it refuses instead of silently committing into someone else's boundary.
    throw new StorageError(
      "An authoritative transaction cannot start inside an unguarded transaction.",
    );
  }

  const previous = tails.get(client) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(
    client,
    previous.then(() => mine),
  );
  await previous.catch(() => undefined);
  try {
    return await holders.run(client, work);
  } finally {
    release();
  }
}
