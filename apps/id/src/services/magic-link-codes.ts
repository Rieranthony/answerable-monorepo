import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import {
  magicLinkBrowserHash,
  magicLinkCodeAttempts,
  magicLinkKeys,
} from "../auth/magic-link.ts";
import {
  recordMagicLinkRefusal,
  type MagicLinkClient,
} from "../auth/magic-link-confirm.ts";
import type { Database, Executor } from "../db/client.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import { magicLinkRequests } from "../db/schema/index.ts";
import type { Environment } from "../env.ts";
import { logEvent } from "../lib/log.ts";

/**
 * Judgement, not a standard. Three comparisons a request give an attacker with a cookie three
 * chances in 10^8 per request. Thirty wrong codes an hour from one client leave an office
 * behind one egress address room for typing errors; a thousand for one firm caps what
 * rotating addresses buys at 10^-5 an hour, against a firm that may simply be large.
 */
export const magicLinkCodeBudgets = {
  clientPerHour: 30,
  organizationPerHour: 1_000,
};

/** A browser holds several requests when a person asks twice; this bounds a request's work. */
const comparedRowsPerAttempt = 10;

const attemptsSince = sql`${magicLinkRequests.attempts} > 0 and ${magicLinkRequests.createdAt} > statement_timestamp() - interval '1 hour'`;

/** Wrong codes counted against one client, from the rows it asked for, on a partial index. */
export const clientCodeFailures = (clientHash: string) => sql`
  select coalesce(sum(${magicLinkRequests.attempts}), 0)::int as wrong
  from ${magicLinkRequests}
  where ${magicLinkRequests.clientHash} = ${clientHash} and ${attemptsSince}`;

/** The same against one firm. */
export const organizationCodeFailures = (organizationId: string) => sql`
  select coalesce(sum(${magicLinkRequests.attempts}), 0)::int as wrong
  from ${magicLinkRequests}
  where ${magicLinkRequests.organizationId} = ${organizationId} and ${attemptsSince}`;

async function failures(tx: Executor, query: ReturnType<typeof sql>) {
  const { rows } = await tx.execute<{ wrong: number }>(query);
  return rows[0]!.wrong;
}

/**
 * One code from one browser. Every comparison is counted and committed first, because a
 * refusal in the sign-in transaction rolls back, and a count that rolled back would make the
 * limit no limit. A row at three is ended for its link as well. The failure budgets add up
 * every purpose's attempts.
 *
 * The answer is the row the code matched, or null, and nothing says why it is null: a browser
 * with no row, a spent budget and a wrong code look alike.
 */
export async function attemptMagicLinkCode(
  db: Database,
  environment: Pick<Environment, "betterAuthSecret" | "betterAuthSecrets">,
  input: {
    browser: string;
    client: string;
    code: string;
    /** A code answers only the page it was mailed for: purposes never cross. */
    purpose: "link" | "connect_directory";
  },
  who: MagicLinkClient,
) {
  const keys = magicLinkKeys(environment);
  const counted = await withDatabaseScope(
    db,
    { kind: "protocol" },
    async (tx) => {
      const held = await tx
        .select()
        .from(magicLinkRequests)
        .where(
          and(
            eq(
              magicLinkRequests.browserHash,
              magicLinkBrowserHash(input.browser),
            ),
            eq(magicLinkRequests.purpose, input.purpose),
            eq(magicLinkRequests.sendStatus, "sent"),
            sql`${magicLinkRequests.expiresAt} > statement_timestamp()`,
            lt(magicLinkRequests.attempts, magicLinkCodeAttempts),
          ),
        )
        .orderBy(desc(magicLinkRequests.createdAt), desc(magicLinkRequests.id))
        .limit(comparedRowsPerAttempt)
        .for("update");
      if (held.length === 0) return [];
      // Checked before any comparison. The asking client's rows count too, so asking from
      // one address and guessing from another does not escape them.
      const spent = new Set<string>();
      const clientSpent = async (hash: string) => {
        if (spent.has(hash)) return true;
        const over =
          (await failures(tx, clientCodeFailures(hash))) >=
          magicLinkCodeBudgets.clientPerHour;
        if (over) {
          spent.add(hash);
          logEvent("magic link", "magic_link_code_budget_exhausted", {
            budget: "client",
          });
        }
        return over;
      };
      if (await clientSpent(keys.clientHash(input.client))) return [];
      const firms = new Map<string, boolean>();
      const allowed: typeof held = [];
      for (const row of held) {
        if (!firms.has(row.organizationId)) {
          const over =
            (await failures(
              tx,
              organizationCodeFailures(row.organizationId),
            )) >= magicLinkCodeBudgets.organizationPerHour;
          firms.set(row.organizationId, over);
          if (over)
            logEvent("magic link", "magic_link_code_budget_exhausted", {
              budget: "organization",
              organizationId: row.organizationId,
            });
        }
        if (firms.get(row.organizationId)) continue;
        if (await clientSpent(row.clientHash)) continue;
        allowed.push(row);
      }
      if (allowed.length === 0) return [];
      await tx
        .update(magicLinkRequests)
        .set({ attempts: sql`${magicLinkRequests.attempts} + 1` })
        .where(
          inArray(
            magicLinkRequests.id,
            allowed.map((row) => row.id),
          ),
        );
      return allowed.map((row) => ({ ...row, attempts: row.attempts + 1 }));
    },
  );
  // Each row's comparison runs whatever the others found.
  const compared = counted.map((row) => ({
    row,
    matched: keys.codeMatches(row.id, input.code, row.codeHmac!),
  }));
  for (const { row, matched } of compared)
    if (!matched && row.attempts >= magicLinkCodeAttempts)
      await recordMagicLinkRefusal(
        db,
        row,
        "auth.magic_link.code_exhausted",
        "code_attempts",
        who,
      );
  return compared.find(({ matched }) => matched)?.row ?? null;
}
