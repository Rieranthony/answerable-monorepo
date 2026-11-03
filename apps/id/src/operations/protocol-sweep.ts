import { sql } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { setDatabaseScope } from "../db/isolation.ts";
import { errorFields } from "../http/problem.ts";
import { logEvent } from "../lib/log.ts";

/**
 * Protocol rows that expire, in sweep order. Access tokens go before refresh
 * tokens so the counts name every expired access row: refresh deletion
 * cascades through `refresh_id` without reporting. Sessions go after the
 * tokens: deleting one sets `session_id` to null on the live tokens that still
 * name it. Verifications and magic-link requests name none of these, and no
 * key joins them to each other.
 */
const tables = [
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "oauth_client_assertions",
  "sessions",
  "verifications",
  "magic_link_requests",
] as const;

type ProtocolSweepCounts = Record<(typeof tables)[number], number>;

/** Which of a table's rows are due, and the indexed column that orders them. */
function dueRows(table: (typeof tables)[number]) {
  return table === "magic_link_requests"
    ? // A request outlives its link so that diagnosis can read it.
      {
        order: sql`created_at`,
        due: sql`created_at < now() - interval '7 days'`,
      }
    : { order: sql`expires_at`, due: sql`expires_at < now()` };
}

/**
 * Delete rows that are due, one short transaction per batch. A rotated refresh
 * row stays until its own expiry: the provider checks expiry before reuse, so
 * the row matters only while it is live. One sweep at a time across processes:
 * a batch that cannot take the lock ends this sweep.
 */
export async function sweepExpiredProtocolRows(
  db: Database,
  batchSize: number,
  isStopping: () => boolean = () => false,
): Promise<ProtocolSweepCounts> {
  const deleted = Object.fromEntries(
    tables.map((table) => [table, 0]),
  ) as ProtocolSweepCounts;
  for (const table of tables) {
    const name = sql.identifier(table);
    const { order, due } = dueRows(table);
    for (;;) {
      if (isStopping()) return deleted;
      const count = await db.transaction(async (tx) => {
        const lock = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext('answerable:protocol-sweep')) as locked`,
        );
        if (!lock.rows[0]!.locked) return undefined;
        await setDatabaseScope(tx, { kind: "protocol" });
        // The array keeps both lookups on indexes at any table size: the
        // batch on its time column, the delete on the primary key.
        const result = await tx.execute(
          sql`delete from ${name} where id = any(array(select id from ${name} where ${due} order by ${order} limit ${batchSize}))`,
        );
        return result.rowCount!;
      });
      if (count === undefined) return deleted;
      deleted[table] += count;
      if (count < batchSize) break;
    }
  }
  return deleted;
}

/** Sweep on a timer; zero disables. Logs counts only when a sweep deleted rows. */
export function startProtocolSweep(
  db: Database,
  { intervalMs, batchSize }: { intervalMs: number; batchSize: number },
) {
  if (intervalMs <= 0) return { stop: async () => {} };
  let stopping = false;
  let running: Promise<void> | undefined;
  const sweep = async () => {
    try {
      const deleted = await sweepExpiredProtocolRows(
        db,
        batchSize,
        () => stopping,
      );
      if (Object.values(deleted).some((count) => count > 0))
        console.log(
          "[id] protocol sweep",
          JSON.stringify({ event: "protocol_sweep", deleted }),
        );
    } catch (error) {
      // The SQLSTATE tells a timeout from a lock wait or a privilege; the
      // message can hold query detail and stays out.
      logEvent("protocol sweep", "protocol_sweep_failed", errorFields(error));
    }
  };
  const timer = setInterval(() => {
    running ??= sweep().finally(() => {
      running = undefined;
    });
  }, intervalMs);
  timer.unref();
  return {
    /** Stop the timer and wait for a running sweep to finish its batch. */
    async stop() {
      stopping = true;
      clearInterval(timer);
      await running;
    },
  };
}
